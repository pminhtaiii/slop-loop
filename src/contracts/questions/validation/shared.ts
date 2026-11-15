import { isCanonicalRelativePath as isFoundationPath } from '../../foundation/uc03/identity.ts';
import type { QuestionLineRangeV1, QuestionValidationError, QuestionValidationResult } from '../contracts.ts';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

export function invalid<T>(code: QuestionValidationError['code'], path: string): QuestionValidationResult<T> {
  return { ok: false, errors: Object.freeze([Object.freeze({ code, path })]) };
}

export function validateId(value: unknown, path: string): QuestionValidationError | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? undefined : { code: 'invalid-id', path };
}

export function validateDigest(value: unknown, path: string): QuestionValidationError | undefined {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value) ? undefined : { code: 'invalid-digest', path };
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isBoundedText(value: unknown, maxBytes = 8_192): value is string {
  return typeof value === 'string' && value.trim().length > 0 && new TextEncoder().encode(value).length <= maxBytes && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value);
}

export function isCanonicalRelativePath(value: unknown, allowRoot = false): value is string {
  return (allowRoot && value === '.') || (typeof value === 'string' && value.length <= 4_096 && isFoundationPath(value));
}

export function validCursor(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    new TextEncoder().encode(value).length <= 512 &&
    !Array.from(value).some(character => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    })
  );
}

export function validateLineRange(input: unknown, path: string): QuestionValidationResult<QuestionLineRangeV1> {
  if (!isRecord(input) || !hasExactKeys(input, ['endLine', 'startLine'])) return invalid('invalid-range', path);
  const startLine = input['startLine'];
  const endLine = input['endLine'];
  if (!isPositiveSafeInteger(startLine) || !isPositiveSafeInteger(endLine) || startLine > endLine) {
    return invalid('invalid-range', path);
  }
  return { ok: true, value: Object.freeze({ startLine, endLine }) };
}
export const MAX_QUESTION_CHUNK_LINES = 60;
export const MAX_QUESTION_CHUNK_NORMALIZED_BYTES = 4_096;

export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.some(candidate => candidate === value);
}
