/** Safe bounded projection shared by review persistence and repair-prompt admission. */
import type { ReviewResult } from '../contracts/foundation/uc03.ts';
import {
  REVIEW_FINDINGS_MAX_BYTES,
  REVIEW_FINDINGS_MAX_ITEMS,
  REVIEW_FINDING_MESSAGE_MAX_BYTES,
  validateReviewFindings,
  type ReviewFindingsRecord,
} from '../contracts/foundation/uc03/v01/review-findings.ts';
import { sanitizeDiagnostic, sanitizeText } from './telemetry.ts';

function safeText(text: string): string {
  return sanitizeText(text).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, '[REDACTED_URL]');
}

/** Reject unsafe metadata; redact and truncate prose before retaining it, never mutate reviewer output. */
export function retainReviewFindings(review: ReviewResult): ReviewFindingsRecord | undefined {
  if (safeText(review.reviewId) !== review.reviewId) return undefined;
  const findings: ReviewFindingsRecord['findings'][number][] = [];
  let truncated = review.findings.length > REVIEW_FINDINGS_MAX_ITEMS;
  for (const finding of review.findings.slice(0, REVIEW_FINDINGS_MAX_ITEMS)) {
    if (safeText(finding.file) !== finding.file) return undefined;
    const message = sanitizeDiagnostic(safeText(finding.message), { maxBytes: REVIEW_FINDING_MESSAGE_MAX_BYTES });
    const item = { file: finding.file, line: finding.line, side: finding.side, severity: finding.severity, message: message.sanitizedContent };
    const candidate: ReviewFindingsRecord = { source: 'reviewer-output', isUntrustedModelOutput: true, reviewId: review.reviewId, findings: [...findings, item], truncated: false };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > REVIEW_FINDINGS_MAX_BYTES) {
      truncated = true;
      break;
    }
    truncated ||= message.truncated;
    findings.push(item);
  }
  return validateReviewFindings({ source: 'reviewer-output', isUntrustedModelOutput: true, reviewId: review.reviewId, findings, truncated }, []);
}

/** Admission also rejects forged snapshots that bypassed the normal persistence projection. */
export function reviewFindingsAreSafe(input: unknown): boolean {
  const record = validateReviewFindings(input, []);
  return record !== undefined && [record.reviewId, ...record.findings.flatMap(finding => [finding.file, finding.message])].every(text => safeText(text) === text);
}
