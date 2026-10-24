import type { ValidationError } from '../foundation/uc03.ts';
import { UC05_APPROVAL_SCHEMA_VERSION } from './contracts-versions.ts';

export const TASK_CONTROL_KEYS = [
  'schemaVersion',
  'taskId',
  'repositoryId',
  'workspaceId',
  'version',
  'epoch',
  'mode',
  'pendingDecisionId',
  'continuationRef',
  'reasonCode',
  'outstandingClaimRefs',
] as const;

export const TASK_CONTROL_MODES = ['runnable', 'waiting', 'rejected', 'recovery-blocked', 'ended'] as const;
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/;
export const SAFE_RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.?($|\/))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** Accept plain records with enumerable string data properties, rejecting accessors and exotic prototypes. */
export function isRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    return Reflect.ownKeys(input).every((key) => {
      if (typeof key !== 'string') return false;
      const descriptor = descriptors[key];
      return descriptor !== undefined && descriptor.enumerable === true && 'value' in descriptor;
    });
  } catch {
    return false;
  }
}

/** Accept standard arrays within the length cap, rejecting holes, accessors and extra properties. */
export function isBoundedDenseArray(input: unknown, maxLength: number): input is unknown[] {
  if (!Array.isArray(input)) return false;
  try {
    if (Object.getPrototypeOf(input) !== Array.prototype || input.length > maxLength) return false;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const key of Reflect.ownKeys(input)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length) return false;
      const descriptor = descriptors[key];
      if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) return false;
    }
    for (let index = 0; index < input.length; index += 1) {
      if (descriptors[String(index)] === undefined) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Append a structured validation failure at the supplied field path. */
export function addError(errors: ValidationError[], path: string, code: string, message: string): void {
  errors.push({ path, code, message });
}

/** Accumulate errors for properties outside the record's explicit schema. */
export function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: ValidationError[]
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedSet.has(key)) addError(errors, path ? `${path}.${key}` : key, 'UNKNOWN_PROPERTY', `Unknown property: ${key}`);
  }
}

/** Require a string containing at least one non-whitespace character. */
export function hasNonEmptyString(input: unknown): input is string {
  return typeof input === 'string' && input.trim().length > 0;
}

/** Recognize bounded identifiers using the approval contract's ASCII vocabulary. */
export function isIdentifier(input: unknown): input is string {
  return typeof input === 'string' && IDENTIFIER_PATTERN.test(input);
}

/** Accumulate an error when a field is not a bounded contract identifier. */
export function validateId(input: unknown, path: string, errors: ValidationError[]): void {
  if (!isIdentifier(input)) addError(errors, path, 'INVALID_ID', `${path} must be a bounded identifier`);
}

/** Accumulate an error unless a numeric bound is a positive safe integer. */
export function validatePositiveInteger(input: unknown, path: string, errors: ValidationError[]): void {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1) {
    addError(errors, path, 'INVALID_BOUND', `${path} must be a finite positive safe integer`);
  }
}

/** Require the canonical sha256 prefix followed by 64 lowercase hexadecimal digits. */
export function validateDigest(input: unknown, path: string, errors: ValidationError[]): void {
  if (typeof input !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input)) {
    addError(errors, path, 'INVALID_DIGEST', `${path} must be a canonical SHA-256 digest`);
  }
}

/** Validate a bounded version label that may use the contract's slash separator. */
export function validateVersionString(input: unknown, path: string, errors: ValidationError[]): void {
  if (typeof input !== 'string' || input.trim().length === 0 || input.length > 128 || /[\u0000-\u001f]/.test(input)) {
    addError(errors, path, 'INVALID_VERSION', `${path} must be a bounded non-empty version string`);
  }
}

/** Require nonempty UTF-8 text within the byte cap, excluding control and bidi formatting characters. */
export function validateBoundedText(input: unknown, path: string, errors: ValidationError[], maxBytes: number): void {
  if (
    !hasNonEmptyString(input) ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(input) ||
    Buffer.byteLength(input, 'utf8') > maxBytes
  ) {
    addError(errors, path, 'INVALID_TEXT', `${path} must be nonempty bounded UTF-8 text without control characters`);
  }
}

/** Validate ISO-8601 timestamps with an explicit timezone and a real calendar date. */
export function validateTimestamp(input: unknown, path: string, errors: ValidationError[]): void {
  const match = typeof input === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(input)
    : null;
  const year = match?.[1] === undefined ? undefined : Number(match[1]);
  const month = match?.[2] === undefined ? undefined : Number(match[2]);
  const day = match?.[3] === undefined ? undefined : Number(match[3]);
  const hour = match?.[4] === undefined ? undefined : Number(match[4]);
  const minute = match?.[5] === undefined ? undefined : Number(match[5]);
  const second = match?.[6] === undefined ? undefined : Number(match[6]);
  const offsetHour = match?.[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match?.[9] === undefined ? 0 : Number(match[9]);
  const validCalendarDate = year !== undefined && month !== undefined && day !== undefined && (() => {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  })();
  if (
    match === null || !validCalendarDate || hour === undefined || hour > 23 || minute === undefined || minute > 59 ||
    second === undefined || second > 59 || offsetHour > 23 || offsetMinute > 59 ||
    typeof input !== 'string' || Number.isNaN(Date.parse(input))
  ) {
    addError(errors, path, 'INVALID_TIMESTAMP', `${path} must be an ISO-8601 timestamp with an explicit timezone`);
  }
}

/** Reject records whose schema version differs from the current UC-05 draft. */
export function validateSchemaVersion(input: Record<string, unknown>, errors: ValidationError[]): void {
  if (input['schemaVersion'] !== UC05_APPROVAL_SCHEMA_VERSION) {
    addError(errors, 'schemaVersion', 'INVALID_SCHEMA_VERSION', `schemaVersion must equal ${UC05_APPROVAL_SCHEMA_VERSION}`);
  }
}

/** Validate up to 128 unique identifiers in a dense array, optionally requiring an entry. */
export function validateIdArray(input: unknown, path: string, errors: ValidationError[], allowEmpty = true): void {
  if (!isBoundedDenseArray(input, 128)) {
    addError(errors, path, 'INVALID_TYPE', `${path} must be a bounded dense array`);
    return;
  }
  if (!allowEmpty && input.length === 0) addError(errors, path, 'EMPTY_ARRAY', `${path} must not be empty`);
  const seen = new Set<string>();
  input.forEach((value: unknown, index: number) => {
    if (!isIdentifier(value)) addError(errors, `${path}[${index}]`, 'INVALID_ID', `${path}[${index}] must be a bounded identifier`);
    else if (seen.has(value)) addError(errors, `${path}[${index}]`, 'DUPLICATE_ID', `${path} must not contain duplicate identifiers`);
    else seen.add(value);
  });
}

/** Create the standard validation failure for a value that is not a plain record. */
export function invalidObject(path: string): ValidationError[] {
  return [{ path, message: `${path} must be a plain object`, code: 'INVALID_TYPE' }];
}

/** Validate task-control fields and consistency between the hold mode and pending decision references. */
