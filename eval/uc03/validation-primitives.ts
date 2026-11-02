import { sanitizeText } from '../../src/foundation/telemetry.ts';
import { EVALUATION_CASE_IDS, type ActualOutcome, type CaseStatus, type EvaluationCaseId, type EvaluationOutcome } from './types.ts';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
export const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const OUTCOMES = new Set<string>(['COMPLETED', 'INCOMPLETE', 'IMPLEMENTED_UNVERIFIED', 'FAILED']);
export const ACTUAL_OUTCOMES = new Set<string>([...OUTCOMES, 'NOT_RUN', 'REFUSED_BEFORE_DISPATCH', 'DRIVER_ERROR', 'DRIVER_RESULT_INVALID']);
const STATUSES = new Set<string>(['pass', 'fail', 'error', 'not-run']);
const CASE_ID_SET = new Set<string>(EVALUATION_CASE_IDS);

export type RecordValue = Record<string, unknown>;

export function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function invalidManifest(): never {
  throw new Error('Invalid manifest');
}

export function invalidOptions(): never {
  throw new Error('Invalid evaluation options');
}

export function invalidDriverResult(): never {
  throw new Error('Invalid evaluation driver result');
}

export function invalidReport(): never {
  throw new Error('Invalid evaluation report');
}

export function invalidWorkflowOptions(): never {
  throw new Error('Invalid workflow evaluation options');
}

export function invalidWorkflow(): never {
  throw new Error('Invalid workflow evaluation report');
}

export function validText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes && sanitizeText(value) === value;
}

export function manifestField(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

export function isEvaluationCaseId(value: unknown): value is EvaluationCaseId {
  return typeof value === 'string' && CASE_ID_SET.has(value);
}

export function isEvaluationOutcome(value: unknown): value is EvaluationOutcome {
  return typeof value === 'string' && OUTCOMES.has(value);
}

export function isCaseStatus(value: unknown): value is CaseStatus {
  return typeof value === 'string' && STATUSES.has(value);
}

export function isActualOutcome(value: unknown): value is ActualOutcome {
  return typeof value === 'string' && ACTUAL_OUTCOMES.has(value);
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

export function reportText(value: unknown, maxBytes: number): string {
  if (!validText(value, maxBytes)) invalidReport();
  return value;
}
