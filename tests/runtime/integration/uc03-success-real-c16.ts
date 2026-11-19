/**
 * The C16 safe-report predicate (real-tier contract §(f) T028; UC-03 T028 final report).
 *
 * C16 is "Sanitized reporting and evidence provenance": the final report excludes prompts, secrets
 * and raw reasoning, retains usage and bounded redacted diagnostics. It is therefore *not* the C01
 * repair verdict: a passing repair predicate says nothing about whether a safe report exists
 * (SPEC-W5-103). This module judges the report on its own content and returns bounded facts only —
 * never report bytes, so nothing it returns can carry a needle.
 */
import { containsProtectedContent } from '../../../src/foundation/docker-workspace-policy.ts';
import type { FinalReport } from '../../../src/uc03/report.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';

/** The largest report the runtime will build; a larger one never reached the graph's own builder. */
const MAX_REPORT_BYTES = 262_144;
/** Bounded evidence references the predicate carries forward. */
const MAX_REFS = 32;

export interface C16ReportFacts {
  readonly present: boolean;
  readonly outcome: string;
  readonly isComplete: boolean;
  readonly diffDigest: string | null;
  readonly evidenceRefs: readonly string[];
  readonly changedFiles: readonly string[];
  readonly bytes: number;
  readonly reportDigest: string;
}

const EMPTY: C16ReportFacts = Object.freeze({
  present: false,
  outcome: 'not-observed',
  isComplete: false,
  diffDigest: null,
  evidenceRefs: Object.freeze([]),
  changedFiles: Object.freeze([]),
  bytes: 0,
  reportDigest: `sha256:${'0'.repeat(64)}`,
});

/**
 * Judges one final report. `pass` requires a report that is present, bounded, free of protected
 * content, internally consistent (a diff digest when it claims completion) and carrying evidence
 * references. Anything else fails: C16 is never inferred from a repair verdict.
 */
export function judgeC16Report(report: FinalReport | undefined): Readonly<{ ok: boolean; reasonCode?: string; facts: C16ReportFacts }> {
  if (report === undefined) return { ok: false, reasonCode: 'c16-report-missing', facts: EMPTY };
  const serialized = JSON.stringify(report);
  const facts: C16ReportFacts = Object.freeze({
    present: true,
    outcome: report.outcome,
    isComplete: report.isComplete,
    diffDigest: typeof report.diff.diffDigest === 'string' ? report.diff.diffDigest : null,
    evidenceRefs: Object.freeze([...report.evidence.evidenceRefs].slice(0, MAX_REFS)),
    changedFiles: Object.freeze([...report.diff.changedFiles].slice(0, MAX_REFS)),
    bytes: Buffer.byteLength(serialized, 'utf8'),
    reportDigest: `sha256:${sha256Text(serialized)}`,
  });
  if (facts.bytes > MAX_REPORT_BYTES) return { ok: false, reasonCode: 'c16-report-oversized', facts };
  // The report must be sanitized: the runtime's own protected-content patterns are the predicate.
  if (containsProtectedContent(serialized)) return { ok: false, reasonCode: 'c16-report-unsafe', facts };
  // Provenance: a report citing no evidence is not a report of anything.
  if (report.evidence.evidenceRefs.length === 0) return { ok: false, reasonCode: 'c16-report-unprovenanced', facts };
  // A completion claim without a diff cannot be a safe report of a change.
  if (report.isComplete && facts.diffDigest === null) return { ok: false, reasonCode: 'c16-report-incomplete', facts };
  return { ok: true, facts };
}
