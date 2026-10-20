/** Shared structural and scalar checks used by contract validators. */

import type { ValidationError } from '../types.ts';

export function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
  errors: ValidationError[]
): void {
  const allowedSet = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      errors.push({
        path: path ? `${path}.${key}` : key,
        message: `Unknown property: ${key}`,
        code: 'UNKNOWN_PROPERTY',
      });
    }
  }
}

export function validateNonEmptyString(
  val: unknown,
  path: string,
  errors: ValidationError[]
): string | undefined {
  if (typeof val !== 'string') {
    errors.push({
      path,
      message: `${path} must be a string`,
      code: 'INVALID_TYPE',
    });
    return undefined;
  }
  const trimmed = val.trim();
  if (trimmed.length === 0) {
    errors.push({
      path,
      message: `${path} must be a non-empty string`,
      code: 'EMPTY_STRING',
    });
    return undefined;
  }
  return trimmed;
}

export function validatePositiveInteger(
  val: unknown,
  path: string,
  errors: ValidationError[]
): number | undefined {
  if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isSafeInteger(val) || val <= 0) {
    errors.push({
      path,
      message: `${path} must be a finite positive integer`,
      code: 'INVALID_POSITIVE_INTEGER',
    });
    return undefined;
  }
  return val;
}

export function validatePositiveNumber(
  val: unknown,
  path: string,
  errors: ValidationError[]
): number | undefined {
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
    errors.push({
      path,
      message: `${path} must be a finite positive number`,
      code: 'INVALID_POSITIVE_NUMBER',
    });
    return undefined;
  }
  return val;
}

export function validateNonNegativeInteger(
  val: unknown,
  path: string,
  errors: ValidationError[]
): number | undefined {
  if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isSafeInteger(val) || val < 0) {
    errors.push({
      path,
      message: `${path} must be a finite non-negative integer`,
      code: 'INVALID_NON_NEGATIVE_INTEGER',
    });
    return undefined;
  }
  return val;
}

export function validateNonNegativeNumber(
  val: unknown,
  path: string,
  errors: ValidationError[]
): number | undefined {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
    errors.push({
      path,
      message: `${path} must be a finite non-negative number`,
      code: 'INVALID_NON_NEGATIVE_NUMBER',
    });
    return undefined;
  }
  return val;
}

export function validateStringArray(
  arr: unknown,
  fieldPath: string,
  errors: ValidationError[],
  options?: { allowEmpty?: boolean }
): void {
  if (!Array.isArray(arr)) {
    errors.push({
      path: fieldPath,
      message: `${fieldPath} must be an array of strings`,
      code: 'INVALID_TYPE',
    });
    return;
  }
  if (!options?.allowEmpty && arr.length === 0) {
    errors.push({
      path: fieldPath,
      message: `${fieldPath} cannot be empty`,
      code: 'ARRAY_EMPTY',
    });
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push({
        path: `${fieldPath}[${i}]`,
        message: `${fieldPath}[${i}] must be a non-empty string`,
        code: 'INVALID_STRING',
      });
    }
  }
}
