import {
  isProtectedPath,
  type ReviewResult,
  type VerificationResult,
  isCanonicalRelativePath,
  validateReviewResult,
  validateVerificationResult,
} from '../../contracts/foundation/uc03.ts';
import { isProtectedPathRef, sanitizeDiagnostic, sanitizeText } from '../../foundation/telemetry.ts';
import type { Milestone, MilestoneKind } from '../report.ts';

const FORBIDDEN_DETAIL_KEY = /reasoning|thinking|prompt|stream|secret|password|credential|authorization|api.?key|token/i;
const MAX_DETAIL_DEPTH = 8;
const MAX_DETAIL_ITEMS = 128;
const MAX_DETAIL_BYTES = 8192;

export const DEFAULT_SUMMARY_BYTES = 1024;
export const DEFAULT_DIFF_BYTES = 65536;
export const MAX_REPORT_BYTES = 262144;
export const MAX_REPORT_ITEMS = 64;
const MAX_METADATA_BYTES = 512;
const PROTECTED_TEXT_MARKER = /UNAPPROVED_CONTEXT|SECRET_KEY|BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY/i;

export interface VerificationSnapshot {
  readonly results: readonly VerificationResult[];
  readonly refs: readonly string[];
  readonly valid: boolean;
}

export interface ReviewSnapshot {
  readonly result: ReviewResult | undefined;
  readonly valid: boolean;
  readonly ref: string | undefined;
}

function rejectMetadata(label: string): never {
  throw new Error(`Protected report metadata rejected: ${label}`);
}

export function safeMetadata<T extends string>(
  value: T,
  label: string,
  customPatterns?: readonly (RegExp | string)[],
): T;
export function safeMetadata(
  value: unknown,
  label: string,
  customPatterns?: readonly (RegExp | string)[]
): string;
export function safeMetadata(
  value: unknown,
  label: string,
  customPatterns?: readonly (RegExp | string)[]
): string {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value, 'utf8') > MAX_METADATA_BYTES ||
    PROTECTED_TEXT_MARKER.test(value) ||
    sanitizeText(value, customPatterns) !== value
  ) {
    return rejectMetadata(label);
  }
  return value;
}

export function safeReference(value: unknown, label: string, customPatterns?: readonly (RegExp | string)[]): string {
  const ref = safeMetadata(value, label, customPatterns);
  if (isProtectedPathRef(ref)) return rejectMetadata(label);
  return ref;
}

export function reportLimit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid report limit: ${name}`);
  return Math.min(value, maximum);
}

export function boundedText(
  value: string,
  maxBytes: number,
  customPatterns?: readonly (RegExp | string)[]
): string {
  return sanitizeDiagnostic(value, {
    maxBytes,
    ...(customPatterns !== undefined ? { customPatterns } : {}),
  }).sanitizedContent;
}

export function safeReferences(
  refs: unknown,
  label: string,
  customPatterns?: readonly (RegExp | string)[]
): readonly string[] {
  if (refs === undefined) return Object.freeze([]);
  if (!Array.isArray(refs) || refs.length > MAX_REPORT_ITEMS) return rejectMetadata(label);
  return Object.freeze(refs.map((ref, index) => safeReference(ref, `${label}[${index}]`, customPatterns)));
}

function sanitizeMilestone(value: unknown, index: number, customPatterns?: readonly (RegExp | string)[]): Milestone {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid report milestone');
  const milestone = value as Record<string, unknown>;
  const outcome = milestone['outcome'];
  if (!isMilestoneOutcome(outcome)) throw new Error(`Invalid report milestone: ${index}`);
  const summary = milestone['summary'];
  if (typeof summary !== 'string') throw new Error(`Invalid report milestone: ${index}`);
  const kind = safeMetadata(milestone['kind'], `milestones[${index}].kind`, customPatterns);
  if (!isMilestoneKind(kind)) throw new Error(`Invalid report milestone: ${index}`);
  return Object.freeze({
    milestoneId: safeMetadata(milestone['milestoneId'], `milestones[${index}].milestoneId`, customPatterns),
    taskId: safeMetadata(milestone['taskId'], `milestones[${index}].taskId`, customPatterns),
    runId: safeMetadata(milestone['runId'], `milestones[${index}].runId`, customPatterns),
    timestamp: safeMetadata(milestone['timestamp'], `milestones[${index}].timestamp`, customPatterns),
    node: safeMetadata(milestone['node'], `milestones[${index}].node`, customPatterns),
    kind,
    summary: boundedText(summary, DEFAULT_SUMMARY_BYTES, customPatterns),
    outcome,
    evidenceRefs: safeReferences(
      milestone['evidenceRefs'],
      `milestones[${index}].evidenceRefs`,
      customPatterns
    ),
    details: sanitizeDetails(milestone['details'], customPatterns),
  });
}

function isMilestoneOutcome(value: unknown): value is Milestone['outcome'] {
  return value === 'success' || value === 'failure' || value === 'pending' || value === 'info';
}

function isMilestoneKind(value: string): value is MilestoneKind {
  return value === 'task_started' || value === 'investigation_completed' || value === 'plan_proposed' ||
    value === 'plan_approved' || value === 'plan_rejected' || value === 'patch_applied' ||
    value === 'verification_completed' || value === 'review_completed' || value === 'replan_triggered' ||
    value === 'budget_exhausted' || value === 'task_completed' || value === 'task_failed' || value === 'task_interrupted';
}

export function safePath(value: unknown, label: string, customPatterns?: readonly (RegExp | string)[]): string {
  if (
    typeof value !== 'string' ||
    !isCanonicalRelativePath(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_METADATA_BYTES ||
    PROTECTED_TEXT_MARKER.test(value) ||
    sanitizeText(value, customPatterns) !== value
  ) {
    return rejectMetadata(label);
  }
  return value;
}

export function combineChangedFiles(
  inputFiles: unknown,
  stateFiles: unknown,
  customPatterns?: readonly (RegExp | string)[]
): { readonly files: readonly string[]; readonly consistent: boolean } {
  const explicit = inputFiles === undefined ? undefined : inputFiles;
  const persisted = Array.isArray(stateFiles) ? stateFiles : undefined;
  if (explicit !== undefined && !Array.isArray(explicit)) return rejectMetadata('changedFiles');
  if ((Array.isArray(explicit) && explicit.length > MAX_REPORT_ITEMS) || (persisted && persisted.length > MAX_REPORT_ITEMS)) {
    return rejectMetadata('changedFiles');
  }
  const cleanExplicit = Array.isArray(explicit)
    ? explicit.map((value, index) => safePath(value, `changedFiles[${index}]`, customPatterns))
    : undefined;
  const cleanPersisted = persisted
    ? persisted.map((value, index) => safePath(value, `state.changedPaths[${index}]`, customPatterns))
    : undefined;
  const sameInventory = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((value) => right.includes(value));
  const consistent = cleanExplicit === undefined || cleanPersisted === undefined || sameInventory(cleanExplicit, cleanPersisted);
  const files = [...new Set([...(cleanExplicit ?? []), ...(cleanPersisted ?? [])])];
  return { files: Object.freeze(files), consistent };
}

export function sanitizedStringList(
  values: unknown,
  label: string,
  customPatterns?: readonly (RegExp | string)[]
): readonly string[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values) || values.length > MAX_REPORT_ITEMS) return rejectMetadata(label);
  return Object.freeze(values.map((value) => {
    if (typeof value !== 'string') return rejectMetadata(label);
    return boundedText(value, DEFAULT_SUMMARY_BYTES, customPatterns);
  }));
}

export function reportMilestones(values: unknown, customPatterns?: readonly (RegExp | string)[]): readonly Milestone[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values) || values.length > MAX_REPORT_ITEMS) return rejectMetadata('milestones');
  return Object.freeze(values.map((value, index) => sanitizeMilestone(value, index, customPatterns)));
}

export function verificationSnapshot(
  value: unknown,
  customPatterns?: readonly (RegExp | string)[],
): VerificationSnapshot {
  const results: VerificationResult[] = [];
  const refs: string[] = [];
  if (!Array.isArray(value) || value.length > MAX_REPORT_ITEMS) return { results, refs, valid: false };
  let valid = true;
  for (const [index, raw] of value.entries()) {
    const checked = validateVerificationResult(raw);
    if (!checked.ok) {
      valid = false;
      continue;
    }
    const result = checked.value;
    safeReference(result.evidenceId, `verificationResults[${index}].evidenceId`, customPatterns);
    safeMetadata(result.taskId, `verificationResults[${index}].taskId`, customPatterns);
    safeMetadata(result.runId, `verificationResults[${index}].runId`, customPatterns);
    safeMetadata(result.actionId, `verificationResults[${index}].actionId`, customPatterns);
    safeMetadata(result.repoDigest, `verificationResults[${index}].repoDigest`, customPatterns);
    if (result.diffDigest !== undefined) safeMetadata(result.diffDigest, `verificationResults[${index}].diffDigest`, customPatterns);
    safeReferences(result.testedIds, `verificationResults[${index}].testedIds`, customPatterns);
    safeReferences(result.diagnosticRefs, `verificationResults[${index}].diagnosticRefs`, customPatterns);
    results.push(result);
    refs.push(result.evidenceId);
  }
  return { results: Object.freeze(results), refs: Object.freeze(refs), valid };
}

export function reviewSnapshot(
  value: unknown,
  customPatterns?: readonly (RegExp | string)[],
): ReviewSnapshot {
  if (value === undefined) return { result: undefined, valid: false, ref: undefined };
  const checked = validateReviewResult(value);
  if (!checked.ok) return { result: undefined, valid: false, ref: undefined };
  const review = checked.value;
  safeReference(review.reviewId, 'reviewResult.reviewId', customPatterns);
  safeMetadata(review.reviewerRoleConfigId, 'reviewResult.reviewerRoleConfigId', customPatterns);
  safeMetadata(review.repoDigest, 'reviewResult.repoDigest', customPatterns);
  safeMetadata(review.diffDigest, 'reviewResult.diffDigest', customPatterns);
  safeMetadata(review.checkSetDigest, 'reviewResult.checkSetDigest', customPatterns);
  safeReference(review.iterationReservationRef, 'reviewResult.iterationReservationRef', customPatterns);
  if (review.findings.length > MAX_REPORT_ITEMS) return { result: undefined, valid: false, ref: undefined };
  const findings = review.findings.map((finding, index) => {
    const file = safePath(finding.file, `reviewResult.findings[${index}].file`, customPatterns);
    if (isProtectedPath(file) || isProtectedPathRef(file)) rejectMetadata(`reviewResult.findings[${index}].file`);
    return Object.freeze({
      ...finding,
      message: boundedText(finding.message, DEFAULT_SUMMARY_BYTES, customPatterns),
      ...(finding.evidenceRef !== undefined
        ? { evidenceRef: safeReference(finding.evidenceRef, `reviewResult.findings[${index}].evidenceRef`, customPatterns) }
        : {}),
    });
  });
  return {
    result: Object.freeze({ ...review, findings: Object.freeze(findings) }),
    valid: true,
    ref: review.reviewId,
  };
}

export function sanitizeDetails(
  details: unknown,
  customPatterns?: readonly (RegExp | string)[],
  seen = new WeakSet<object>(),
  depth = 0,
  budget = { items: 0 }
): Record<string, unknown> | undefined {
  if (details === undefined) {
    return undefined;
  }
  try {
    if (!details || typeof details !== 'object' || Array.isArray(details) || depth > MAX_DETAIL_DEPTH || seen.has(details)) {
      throw new Error();
    }
    seen.add(details);
    const result: Record<string, unknown> = {};
    try {
      for (const [key, value] of Object.entries(details as Record<string, unknown>).slice(0, MAX_DETAIL_ITEMS)) {
        if (FORBIDDEN_DETAIL_KEY.test(key) || budget.items >= MAX_DETAIL_ITEMS) continue;
        budget.items++;
        const clean = sanitizeDetailValue(value, customPatterns, seen, depth + 1, budget);
        const candidate = { ...result };
        Object.defineProperty(candidate, key, { value: clean, enumerable: true });
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= MAX_DETAIL_BYTES) {
          Object.defineProperty(result, key, { value: clean, enumerable: true });
        }
      }
      return Object.freeze(result);
    } finally {
      seen.delete(details);
    }
  } catch {
    throw new TypeError('Invalid report details');
  }
}

function sanitizeDetailValue(
  value: unknown,
  customPatterns: readonly (RegExp | string)[] | undefined,
  seen: WeakSet<object>,
  depth: number,
  budget: { items: number }
): unknown {
  if (depth > MAX_DETAIL_DEPTH || budget.items >= MAX_DETAIL_ITEMS) return undefined;
  if (typeof value === 'string') {
    const options = customPatterns === undefined ? { maxBytes: 1024 } : { maxBytes: 1024, customPatterns };
    return sanitizeDiagnostic(value, options).sanitizedContent;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error();
    seen.add(value);
    try {
      const result = value.slice(0, MAX_DETAIL_ITEMS).flatMap((item) => {
        if (budget.items >= MAX_DETAIL_ITEMS) return [];
        budget.items++;
        return [sanitizeDetailValue(item, customPatterns, seen, depth + 1, budget)];
      });
      return Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_DETAIL_BYTES
        ? Object.freeze(result)
        : Object.freeze([]);
    } finally {
      seen.delete(value);
    }
  }
  if (value !== null && typeof value === 'object') {
    return sanitizeDetails(value, customPatterns, seen, depth, budget);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error();
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') throw new Error();
  return value;
}
