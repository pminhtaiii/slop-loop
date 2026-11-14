import type {
  AnswerQuestionDecisionV1,
  ClarifyQuestionDecisionV1,
  InsufficientQuestionDecisionV1,
  QuestionClaimV1,
  QuestionEvidenceReferenceV1,
  QuestionModelDecisionV1,
  QuestionModelResponseV1,
  QuestionUsageV1,
  QuestionUsageUnknownReasonV1,
  QuestionValidationResult,
} from '../contracts.ts';
import { hasExactKeys, invalid, isBoundedText, isNonNegativeSafeInteger, isRecord, isCanonicalRelativePath, validCursor, validateId, validateLineRange } from './shared.ts';

const MAX_EVIDENCE_REFERENCES = 20;
const MAX_CLAIMS = 20;
const MAX_LIST_ITEMS = 10;
const USAGE_UNKNOWN_REASONS = ['provider-error', 'timeout', 'invalid-metadata', 'over-reservation', 'cancelled', 'unknown'] as const;

function validateEvidenceReference(input: unknown, path: string): QuestionValidationResult<QuestionEvidenceReferenceV1> {
  if (!isRecord(input) || !hasExactKeys(input, ['evidenceId', 'range'])) return invalid('invalid-shape', path);
  const idError = validateId(input['evidenceId'], path + '.evidenceId');
  if (idError) return { ok: false, errors: Object.freeze([Object.freeze(idError)]) };
  const range = validateLineRange(input['range'], path + '.range');
  if (!range.ok) return range;
  return {
    ok: true,
    value: Object.freeze({ evidenceId: input['evidenceId'] as string, range: range.value }),
  };
}

function validateQuestionClaim(input: unknown, path: string): QuestionValidationResult<QuestionClaimV1> {
  if (!isRecord(input) || !hasExactKeys(input, ['claimId', 'evidence', 'kind', 'text'])) return invalid('invalid-decision', path);
  const idError = validateId(input['claimId'], path + '.claimId');
  if (idError) return { ok: false, errors: Object.freeze([Object.freeze(idError)]) };
  if (!isBoundedText(input['text'])) return invalid('invalid-decision', path + '.text');
  if (input['kind'] !== 'observation' && input['kind'] !== 'inference') return invalid('invalid-decision', path + '.kind');
  const evidence = input['evidence'];
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > MAX_EVIDENCE_REFERENCES) {
    return invalid('invalid-decision', path + '.evidence');
  }
  const references: QuestionEvidenceReferenceV1[] = [];
  for (let index = 0; index < evidence.length; index += 1) {
    const reference = validateEvidenceReference(evidence[index], path + '.evidence[' + index + ']');
    if (!reference.ok) return reference;
    references.push(reference.value);
  }
  return {
    ok: true,
    value: Object.freeze({
      claimId: input['claimId'] as string,
      text: input['text'],
      kind: input['kind'],
      evidence: Object.freeze(references),
    }),
  };
}

function validateClaims(input: unknown, path: string, allowEmpty = false): QuestionValidationResult<readonly QuestionClaimV1[]> {
  if (!Array.isArray(input) || input.length > MAX_CLAIMS || (!allowEmpty && input.length === 0)) {
    return invalid('invalid-decision', path);
  }
  const claims: QuestionClaimV1[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const claim = validateQuestionClaim(input[index], path + '[' + index + ']');
    if (!claim.ok) return claim;
    claims.push(claim.value);
  }
  return { ok: true, value: Object.freeze(claims) };
}

function validateTextList(input: unknown, path: string, minItems: number, maxItems: number, itemBytes: number): QuestionValidationResult<readonly string[]> {
  if (!Array.isArray(input) || input.length < minItems || input.length > maxItems) return invalid('invalid-decision', path);
  const values: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    if (!isBoundedText(input[index], itemBytes)) return invalid('invalid-decision', path + '[' + index + ']');
    values.push(input[index]);
  }
  return { ok: true, value: Object.freeze(values) };
}

/** Validates one complete tool or terminal decision and returns a detached immutable copy. */
export function validateQuestionDecision(input: unknown): QuestionValidationResult<QuestionModelDecisionV1> {
  if (!isRecord(input) || typeof input['kind'] !== 'string') return invalid('invalid-decision', 'decision');
  const kind = input['kind'];

  if (kind === 'list') {
    if (!hasExactKeys(input, input['cursor'] === undefined ? ['kind', 'path'] : ['cursor', 'kind', 'path'])) {
      return invalid('invalid-decision', 'decision');
    }
    const path = input['path'];
    const cursor = input['cursor'];
    if (!isCanonicalRelativePath(path)) return invalid('invalid-decision', 'decision.path');
    if (cursor !== undefined && !validCursor(cursor)) return invalid('invalid-decision', 'decision.cursor');
    const value = cursor === undefined ? { kind: 'list' as const, path } : { kind: 'list' as const, path, cursor };
    return { ok: true, value: Object.freeze(value) };
  }

  if (kind === 'search') {
    const expected = ['kind', 'query'];
    if (input['pathPrefix'] !== undefined) expected.push('pathPrefix');
    if (input['cursor'] !== undefined) expected.push('cursor');
    if (!hasExactKeys(input, expected)) return invalid('invalid-decision', 'decision');
    const query = input['query'];
    const pathPrefix = input['pathPrefix'];
    const cursor = input['cursor'];
    if (!isBoundedText(query, 4_096) || query.includes(String.fromCharCode(10)) || query.includes(String.fromCharCode(13))) {
      return invalid('invalid-decision', 'decision.query');
    }
    if (pathPrefix !== undefined && !isCanonicalRelativePath(pathPrefix)) return invalid('invalid-decision', 'decision.pathPrefix');
    if (cursor !== undefined && !validCursor(cursor)) return invalid('invalid-decision', 'decision.cursor');
    const value =
      pathPrefix === undefined
        ? cursor === undefined
          ? { kind: 'search' as const, query }
          : { kind: 'search' as const, query, cursor }
        : cursor === undefined
          ? { kind: 'search' as const, query, pathPrefix }
          : { kind: 'search' as const, query, pathPrefix, cursor };
    return { ok: true, value: Object.freeze(value) };
  }
  if (kind === 'read') {
    if (!hasExactKeys(input, ['endLine', 'kind', 'path', 'startLine'])) return invalid('invalid-decision', 'decision');
    if (!isCanonicalRelativePath(input['path'])) return invalid('invalid-decision', 'decision.path');
    const range = validateLineRange({ startLine: input['startLine'], endLine: input['endLine'] }, 'decision.range');
    if (!range.ok) return { ok: false, errors: Object.freeze(range.errors.map(error => Object.freeze({ code: 'invalid-range' as const, path: error.path }))) };
    return { ok: true, value: Object.freeze({ kind, path: input['path'], ...range.value }) };
  }

  if (kind === 'answer') {
    if (!hasExactKeys(input, ['claims', 'kind', 'limitations'])) return invalid('invalid-decision', 'decision');
    const claims = validateClaims(input['claims'], 'decision.claims');
    const limitations = validateTextList(input['limitations'], 'decision.limitations', 0, MAX_LIST_ITEMS, 2_048);
    if (!claims.ok) return claims;
    if (!limitations.ok) return limitations;
    const value: AnswerQuestionDecisionV1 = Object.freeze({ kind, claims: claims.value, limitations: limitations.value });
    return { ok: true, value };
  }

  if (kind === 'clarify') {
    if (!hasExactKeys(input, ['explanation', 'kind', 'question', 'unresolvedReferents'])) {
      return invalid('invalid-decision', 'decision');
    }
    if (!isBoundedText(input['question'], 2_048) || !isBoundedText(input['explanation'], 2_048)) {
      return invalid('invalid-decision', 'decision');
    }
    const referents = validateTextList(input['unresolvedReferents'], 'decision.unresolvedReferents', 1, 8, 512);
    if (!referents.ok) return referents;
    const value: ClarifyQuestionDecisionV1 = Object.freeze({
      kind,
      question: input['question'],
      explanation: input['explanation'],
      unresolvedReferents: referents.value,
    });
    return { ok: true, value };
  }

  if (kind === 'insufficient') {
    const hasClaims = input['claims'] !== undefined;
    if (!hasExactKeys(input, hasClaims ? ['claims', 'explanation', 'kind'] : ['explanation', 'kind'])) {
      return invalid('invalid-decision', 'decision');
    }
    if (!isBoundedText(input['explanation'], 2_048)) return invalid('invalid-decision', 'decision.explanation');
    if (!hasClaims) {
      const value: InsufficientQuestionDecisionV1 = Object.freeze({ kind, explanation: input['explanation'] });
      return { ok: true, value };
    }
    const claims = validateClaims(input['claims'], 'decision.claims', true);
    if (!claims.ok) return claims;
    const value: InsufficientQuestionDecisionV1 = Object.freeze({
      kind,
      explanation: input['explanation'],
      claims: claims.value,
    });
    return { ok: true, value };
  }

  return invalid('invalid-decision', 'decision.kind');
}

/** Validates trusted provider usage metadata without treating missing or uncertain usage as complete. */
export function validateQuestionUsage(input: unknown): QuestionValidationResult<QuestionUsageV1> {
  if (!isRecord(input) || typeof input['status'] !== 'string') return invalid('invalid-usage', 'usage');
  if (input['status'] === 'missing') {
    return hasExactKeys(input, ['status']) ? { ok: true, value: Object.freeze({ status: 'missing' }) } : invalid('invalid-usage', 'usage');
  }
  if (input['status'] === 'unknown') {
    const reasonCode = input['reasonCode'];
    if (!hasExactKeys(input, ['reasonCode', 'status']) || typeof reasonCode !== 'string' || !USAGE_UNKNOWN_REASONS.includes(reasonCode as (typeof USAGE_UNKNOWN_REASONS)[number])) {
      return invalid('invalid-usage', 'usage');
    }
    return {
      ok: true,
      value: Object.freeze({ status: 'unknown', reasonCode: reasonCode as QuestionUsageUnknownReasonV1 }),
    };
  }
  if (input['status'] !== 'complete' || !hasExactKeys(input, ['inputTokens', 'outputTokens', 'status'])) {
    return invalid('invalid-usage', 'usage');
  }
  const inputTokens = input['inputTokens'];
  const outputTokens = input['outputTokens'];
  if (!isNonNegativeSafeInteger(inputTokens) || !isNonNegativeSafeInteger(outputTokens) || !Number.isSafeInteger(inputTokens + outputTokens)) {
    return invalid('invalid-usage', 'usage');
  }
  return { ok: true, value: Object.freeze({ status: 'complete', inputTokens, outputTokens }) };
}

/** Validates a decision and its accounting observation as one model-port response. */
export function validateQuestionModelResponse(input: unknown): QuestionValidationResult<QuestionModelResponseV1> {
  if (!isRecord(input) || !hasExactKeys(input, ['decision', 'usage'])) return invalid('invalid-shape', 'modelResponse');
  const decision = validateQuestionDecision(input['decision']);
  if (!decision.ok) return decision;
  const usage = validateQuestionUsage(input['usage']);
  if (!usage.ok) return usage;
  return { ok: true, value: Object.freeze({ decision: decision.value, usage: usage.value }) };
}
