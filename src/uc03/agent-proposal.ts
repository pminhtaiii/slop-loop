import { isCanonicalRelativePath, isProtectedPath, type ValidationError, type ValidationResult } from '../contracts/foundation/uc03.ts';
import { parseUnifiedDiff } from '../foundation/reviewer.ts';
import type { CoderKind, CoderProposal, CoderQuestion } from './agent-types.ts';

const BODY_LIMIT_BYTES = 64 * 1024;
const PATH_LIMIT_BYTES = 512;
const REF_LIMIT_BYTES = 128;
const PROSE_LIMIT_BYTES = 4096;
const QUERY_LIMIT_BYTES = 1024;
const DIFF_LIMIT_BYTES = 48 * 1024;
const LIST_LIMIT = 16;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const SAFE_REASON = /^[a-z][a-z0-9-]*$/u;
const SUCCESS_CLAIMS = new Set(['success', 'completed', 'complete', 'done', 'fixed', 'passed']);

const VARIANT_FIELDS: Readonly<Record<CoderKind, readonly string[]>> = {
  inspect: ['operation', 'args'],
  'propose-plan': ['diagnosis', 'strategy', 'suspectedLocations', 'scopedPaths', 'evidenceRefs'],
  'propose-patch': ['diff', 'targetPaths', 'approvedPlanRef'],
  'request-info': ['questions', 'evidenceRefs'],
  stop: ['reasonCode', 'summary', 'evidenceRefs'],
};

const utf8Bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

function fieldError(path: string, message: string, code: string): ValidationError {
  return { path, message, code };
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[], path: string, errors: ValidationError[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) errors.push(fieldError(path ? `${path}.${key}` : key, `Unknown property: ${key}`, 'UNKNOWN_PROPERTY'));
  }
}

function checkIdentifier(value: unknown, path: string, errors: ValidationError[]): string | undefined {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value) || utf8Bytes(value) > REF_LIMIT_BYTES) {
    errors.push(fieldError(path, 'must be a 1-128 byte safe identifier', 'INVALID_IDENTIFIER'));
    return undefined;
  }
  return value;
}

function checkRef(value: unknown, path: string, errors: ValidationError[]): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(fieldError(path, 'must be a non-empty reference', 'INVALID_REF'));
    return undefined;
  }
  if (utf8Bytes(value) > REF_LIMIT_BYTES) {
    errors.push(fieldError(path, `must be at most ${REF_LIMIT_BYTES} bytes`, 'REF_TOO_LONG'));
    return undefined;
  }
  return value;
}

function checkProse(value: unknown, path: string, errors: ValidationError[]): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(fieldError(path, 'must be non-empty prose', 'INVALID_PROSE'));
    return undefined;
  }
  if (utf8Bytes(value) > PROSE_LIMIT_BYTES) {
    errors.push(fieldError(path, `must be at most ${PROSE_LIMIT_BYTES} bytes`, 'INVALID_PROSE'));
    return undefined;
  }
  return value;
}

function checkQuery(value: unknown, path: string, errors: ValidationError[]): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(fieldError(path, 'must be a non-empty query', 'INVALID_QUERY'));
    return undefined;
  }
  if (utf8Bytes(value) > QUERY_LIMIT_BYTES) {
    errors.push(fieldError(path, `must be at most ${QUERY_LIMIT_BYTES} bytes`, 'QUERY_TOO_LONG'));
    return undefined;
  }
  return value;
}

function checkDiff(value: unknown, path: string, errors: ValidationError[]): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(fieldError(path, 'must be a non-empty unified diff', 'INVALID_DIFF'));
    return undefined;
  }
  if (utf8Bytes(value) > DIFF_LIMIT_BYTES) {
    errors.push(fieldError(path, `must be at most ${DIFF_LIMIT_BYTES} bytes`, 'DIFF_TOO_LONG'));
    return undefined;
  }
  return value;
}

function checkPath(value: unknown, path: string, errors: ValidationError[]): string | undefined {
  if (typeof value !== 'string' || !isCanonicalRelativePath(value) || isProtectedPath(value)) {
    errors.push(fieldError(path, 'must be a canonical non-protected relative path', 'INVALID_PATH'));
    return undefined;
  }
  if (utf8Bytes(value) > PATH_LIMIT_BYTES) {
    errors.push(fieldError(path, `must be at most ${PATH_LIMIT_BYTES} bytes`, 'PATH_TOO_LONG'));
    return undefined;
  }
  return value;
}

function checkReason(value: unknown, path: string, errors: ValidationError[]): string | undefined {
  if (typeof value !== 'string' || !SAFE_REASON.test(value) || utf8Bytes(value) > REF_LIMIT_BYTES || SUCCESS_CLAIMS.has(value)) {
    errors.push(fieldError(path, 'must be a safe non-success reason code', 'UNSAFE_REASON'));
    return undefined;
  }
  return value;
}

function checkList(value: unknown, path: string, errors: ValidationError[], min: number): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(fieldError(path, 'must be an array', 'INVALID_LIST'));
    return undefined;
  }
  if (value.length < min || value.length > LIST_LIMIT) {
    errors.push(fieldError(path, `must contain ${min}-${LIST_LIMIT} items`, 'LIST_TOO_LONG'));
    return undefined;
  }
  return value;
}

function pathList(value: unknown, path: string, errors: ValidationError[]): string[] | undefined {
  const items = checkList(value, path, errors, 1);
  if (items === undefined) return undefined;
  const out: string[] = [];
  items.forEach((item, index) => {
    const parsed = checkPath(item, `${path}[${index}]`, errors);
    if (parsed !== undefined) out.push(parsed);
  });
  return out;
}

function refList(value: unknown, path: string, errors: ValidationError[], min: number): string[] | undefined {
  const items = checkList(value, path, errors, min);
  if (items === undefined) return undefined;
  const out: string[] = [];
  items.forEach((item, index) => {
    const parsed = checkRef(item, `${path}[${index}]`, errors);
    if (parsed !== undefined) out.push(parsed);
  });
  return out;
}

function questionList(value: unknown, path: string, errors: ValidationError[]): CoderQuestion[] | undefined {
  const items = checkList(value, path, errors, 1);
  if (items === undefined) return undefined;
  const questions: CoderQuestion[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const at = `${path}[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push(fieldError(at, 'must be an object', 'INVALID_QUESTION'));
      return;
    }
    const record = item as Record<string, unknown>;
    rejectUnknown(record, ['questionId', 'text'], at, errors);
    const questionId = checkIdentifier(record['questionId'], `${at}.questionId`, errors);
    const text = checkProse(record['text'], `${at}.text`, errors);
    if (questionId === undefined || text === undefined) return;
    if (seen.has(questionId)) {
      errors.push(fieldError(`${at}.questionId`, 'must be unique within the proposal', 'DUPLICATE_QUESTION'));
      return;
    }
    seen.add(questionId);
    questions.push({ questionId, text });
  });
  return questions;
}

function parseInspect(record: Record<string, unknown>, proposalId: string, errors: ValidationError[]): CoderProposal | null {
  const operation = record['operation'];
  if (operation !== 'list_dir' && operation !== 'read_file' && operation !== 'search_code' && operation !== 'run_check') {
    errors.push(fieldError('operation', 'must be list_dir, read_file, search_code or run_check', 'UNKNOWN_OPERATION'));
    return null;
  }
  const rawArgs = record['args'];
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
    errors.push(fieldError('args', 'must be an object', 'INVALID_TYPE'));
    return null;
  }
  const args = rawArgs as Record<string, unknown>;
  if (operation === 'search_code') {
    rejectUnknown(args, ['query'], 'args', errors);
    const query = checkQuery(args['query'], 'args.query', errors);
    return query === undefined ? null : { kind: 'inspect', proposalId, operation, args: { query } };
  }
  if (operation === 'run_check') {
    rejectUnknown(args, ['checkId'], 'args', errors);
    const checkId = checkIdentifier(args['checkId'], 'args.checkId', errors);
    return checkId === undefined ? null : { kind: 'inspect', proposalId, operation, args: { checkId } };
  }
  rejectUnknown(args, ['path'], 'args', errors);
  const path = checkPath(args['path'], 'args.path', errors);
  return path === undefined ? null : { kind: 'inspect', proposalId, operation, args: { path } };
}

function parsePlan(record: Record<string, unknown>, proposalId: string, errors: ValidationError[]): CoderProposal | null {
  const diagnosis = checkProse(record['diagnosis'], 'diagnosis', errors);
  const strategy = checkProse(record['strategy'], 'strategy', errors);
  const suspectedLocations = pathList(record['suspectedLocations'], 'suspectedLocations', errors);
  const scopedPaths = pathList(record['scopedPaths'], 'scopedPaths', errors);
  const evidenceRefs = refList(record['evidenceRefs'], 'evidenceRefs', errors, 1);
  if (diagnosis === undefined || strategy === undefined || suspectedLocations === undefined || scopedPaths === undefined || evidenceRefs === undefined) return null;
  return { kind: 'propose-plan', proposalId, diagnosis, strategy, suspectedLocations, scopedPaths, evidenceRefs };
}

function parsePatch(record: Record<string, unknown>, proposalId: string, errors: ValidationError[]): CoderProposal | null {
  const diff = checkDiff(record['diff'], 'diff', errors);
  const targetPaths = pathList(record['targetPaths'], 'targetPaths', errors);
  const approvedPlanRef = checkRef(record['approvedPlanRef'], 'approvedPlanRef', errors);
  if (diff === undefined || targetPaths === undefined || approvedPlanRef === undefined) return null;
  if (parseUnifiedDiff(diff) === null) {
    errors.push(fieldError('diff', 'must be a unified diff', 'DIFF_NOT_UNIFIED'));
    return null;
  }
  return { kind: 'propose-patch', proposalId, diff, targetPaths, approvedPlanRef };
}

/** Strict parser for one coder proposal; performs no effects and never throws. */
export function parseCoderProposal(content: string): ValidationResult<CoderProposal> {
  if (typeof content !== 'string') return { ok: false, errors: [fieldError('proposal', 'must be a JSON string', 'INVALID_TYPE')] };
  if (utf8Bytes(content) > BODY_LIMIT_BYTES) return { ok: false, errors: [fieldError('proposal', `must be at most ${BODY_LIMIT_BYTES} bytes`, 'BODY_TOO_LONG')] };
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { ok: false, errors: [fieldError('proposal', 'must be valid JSON', 'MALFORMED_JSON')] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: [fieldError('proposal', 'must be one JSON object', 'INVALID_TYPE')] };
  const record = raw as Record<string, unknown>;
  const kind = record['kind'];
  if (kind !== 'inspect' && kind !== 'propose-plan' && kind !== 'propose-patch' && kind !== 'request-info' && kind !== 'stop') {
    return { ok: false, errors: [fieldError('kind', 'must be inspect, propose-plan, propose-patch, request-info or stop', 'UNKNOWN_KIND')] };
  }
  const errors: ValidationError[] = [];
  rejectUnknown(record, ['kind', 'proposalId', ...VARIANT_FIELDS[kind]], '', errors);
  const proposalId = checkIdentifier(record['proposalId'], 'proposalId', errors);
  if (proposalId === undefined) return { ok: false, errors };

  let proposal: CoderProposal | null;
  if (kind === 'inspect') {
    proposal = parseInspect(record, proposalId, errors);
  } else if (kind === 'propose-plan') {
    proposal = parsePlan(record, proposalId, errors);
  } else if (kind === 'propose-patch') {
    proposal = parsePatch(record, proposalId, errors);
  } else if (kind === 'request-info') {
    const questions = questionList(record['questions'], 'questions', errors);
    const evidenceRefs = refList(record['evidenceRefs'], 'evidenceRefs', errors, 0);
    proposal = questions === undefined || evidenceRefs === undefined ? null : { kind: 'request-info', proposalId, questions, evidenceRefs };
  } else {
    const reasonCode = checkReason(record['reasonCode'], 'reasonCode', errors);
    const summary = checkProse(record['summary'], 'summary', errors);
    const evidenceRefs = refList(record['evidenceRefs'], 'evidenceRefs', errors, 0);
    proposal = reasonCode === undefined || summary === undefined || evidenceRefs === undefined ? null : { kind: 'stop', proposalId, reasonCode, summary, evidenceRefs };
  }
  return errors.length > 0 || proposal === null ? { ok: false, errors } : { ok: true, value: proposal };
}
