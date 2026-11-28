/** Bounded reviewer-output snapshot retained with the case, independent of completion authority. */
import type { ReviewFinding, ValidationError } from './types.ts';
import { isPlainObject, rejectUnknownKeys } from './validation/common.ts';
import { validateReviewFinding } from './validation/evidence/review.ts';

export const REVIEW_FINDINGS_MAX_ITEMS = 16;
export const REVIEW_FINDINGS_MAX_BYTES = 16384;
export const REVIEW_FINDING_MESSAGE_MAX_BYTES = 2048;
export const REVIEW_FINDING_FILE_MAX_BYTES = 512;
export const REVIEW_ID_MAX_BYTES = 256;

export interface ReviewFindingsRecord {
  readonly source: 'reviewer-output';
  readonly isUntrustedModelOutput: true;
  readonly reviewId: string;
  readonly findings: readonly Omit<ReviewFinding, 'evidenceRef'>[];
  readonly truncated: boolean;
}

/** Validate persisted/restored snapshots and direct transport inputs using the same limits. */
export function validateReviewFindings(input: unknown, errors: ValidationError[]): ReviewFindingsRecord | undefined {
  const before = errors.length;
  const fail = (): undefined => {
    errors.push({ path: 'reviewFindings', code: 'INVALID_REVIEW_FINDINGS', message: 'Review findings must be a bounded reviewer-output snapshot' });
    return undefined;
  };
  if (!isPlainObject(input)) return fail();
  rejectUnknownKeys(input, ['source', 'isUntrustedModelOutput', 'reviewId', 'findings', 'truncated'], 'reviewFindings', errors);
  if (
    input.source !== 'reviewer-output' ||
    input.isUntrustedModelOutput !== true ||
    typeof input.truncated !== 'boolean' ||
    typeof input.reviewId !== 'string' ||
    !input.reviewId.trim() ||
    Buffer.byteLength(input.reviewId, 'utf8') > REVIEW_ID_MAX_BYTES ||
    !Array.isArray(input.findings) ||
    input.findings.length > REVIEW_FINDINGS_MAX_ITEMS
  )
    return fail();
  const findings: Omit<ReviewFinding, 'evidenceRef'>[] = [];
  for (const item of input.findings) {
    const checked = validateReviewFinding(item);
    if (!checked.ok) return fail();
    const finding = checked.value;
    if (finding.evidenceRef !== undefined || Buffer.byteLength(finding.file, 'utf8') > REVIEW_FINDING_FILE_MAX_BYTES || Buffer.byteLength(finding.message, 'utf8') > REVIEW_FINDING_MESSAGE_MAX_BYTES)
      return fail();
    findings.push({ file: finding.file, line: finding.line, side: finding.side, severity: finding.severity, message: finding.message });
  }
  const record: ReviewFindingsRecord = { source: 'reviewer-output', isUntrustedModelOutput: true, reviewId: input.reviewId, findings, truncated: input.truncated };
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > REVIEW_FINDINGS_MAX_BYTES) return fail();
  return errors.length === before ? record : undefined;
}
