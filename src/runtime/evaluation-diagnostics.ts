/** Bounded stage/component diagnostics for specs/007 integration contract §5. */

import { isProtectedPathRef, sanitizeDiagnostic, sanitizeText } from '../foundation/telemetry.ts';

export const DIAGNOSTIC_STAGES = ['preflight', 'intake', 'investigate', 'approve', 'patch', 'verify', 'review', 'grade', 'deliver'] as const;
export const DIAGNOSTIC_COMPONENTS = ['provider', 'model-output', 'repository-tool', 'container', 'state-accounting', 'approval', 'workflow', 'grader', 'operator-input'] as const;
export const DIAGNOSTIC_ATTRIBUTIONS = ['environment', 'integration', 'tool', 'model', 'verification', 'review', 'human', 'unknown'] as const;
export const DIAGNOSTIC_CONFIDENCES = ['observed', 'inferred', 'unknown'] as const;

export type DiagnosticStage = (typeof DIAGNOSTIC_STAGES)[number] | 'unknown';
export type DiagnosticComponent = (typeof DIAGNOSTIC_COMPONENTS)[number] | 'unknown';
export type DiagnosticAttribution = (typeof DIAGNOSTIC_ATTRIBUTIONS)[number];
export type DiagnosticConfidence = (typeof DIAGNOSTIC_CONFIDENCES)[number];
export type DiagnosticObservation = 'observed' | 'unknown';

export interface EvaluationDiagnostic {
  readonly stage: DiagnosticStage;
  readonly component: DiagnosticComponent;
  readonly attribution: DiagnosticAttribution;
  readonly attributionConfidence: DiagnosticConfidence;
  /** Safe identifier only: never an exception message, stack, path or credential. */
  readonly reasonCode: string;
  readonly evidenceRefs: readonly string[];
  readonly milestones: readonly string[];
  readonly limitations: readonly string[];
  readonly usage: DiagnosticObservation;
  readonly effects: DiagnosticObservation;
}

export interface EvaluationDiagnosticInput {
  readonly stage?: string | undefined;
  readonly component?: string | undefined;
  readonly attribution?: string | undefined;
  readonly attributionConfidence?: string | undefined;
  readonly reasonCode?: string | undefined;
  readonly evidenceRefs?: readonly string[] | undefined;
  readonly milestones?: readonly string[] | undefined;
  readonly limitations?: readonly string[] | undefined;
  readonly usage?: DiagnosticObservation | undefined;
  readonly effects?: DiagnosticObservation | undefined;
}

const GENERIC_REASON_CODE = 'unattributed-failure';
const SAFE_REASON_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_ITEMS = 32;
const MAX_TEXT_BYTES = 512;

function safeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = sanitizeDiagnostic(value, { maxBytes: MAX_TEXT_BYTES });
  // A ref that had to be redacted is no longer a usable reference; drop it rather than keep '[REDACTED]'.
  if (clean.redacted) return undefined;
  return clean.sanitizedContent.length > 0 ? clean.sanitizedContent : undefined;
}

/** Evidence refs are filtered and deduplicated; milestone and limitation text keeps its order and repeats. */
function boundedList(values: readonly string[] | undefined, asReference: boolean): readonly string[] {
  if (!Array.isArray(values)) return Object.freeze([]);
  const out: string[] = [];
  for (const value of values) {
    const clean = safeText(value);
    if (clean === undefined || isProtectedPathRef(clean) || (asReference && out.includes(clean))) continue;
    out.push(clean);
    if (out.length === MAX_ITEMS) break;
  }
  return Object.freeze(out);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : undefined;
}

function safeReasonCode(value: unknown): string {
  return typeof value === 'string' && SAFE_REASON_CODE.test(value) && sanitizeText(value) === value ? value : GENERIC_REASON_CODE;
}

/** Unknown or unrecognised stage/component degrades to unknown attribution rather than guessing. */
export function createEvaluationDiagnostic(input: EvaluationDiagnosticInput = {}): EvaluationDiagnostic {
  const stage = oneOf(DIAGNOSTIC_STAGES, input.stage);
  const component = oneOf(DIAGNOSTIC_COMPONENTS, input.component);
  const proven = stage !== undefined && component !== undefined;
  return Object.freeze({
    stage: stage ?? 'unknown',
    component: component ?? 'unknown',
    attribution: proven ? (oneOf(DIAGNOSTIC_ATTRIBUTIONS, input.attribution) ?? 'unknown') : 'unknown',
    attributionConfidence: proven ? (oneOf(DIAGNOSTIC_CONFIDENCES, input.attributionConfidence) ?? 'unknown') : 'unknown',
    reasonCode: safeReasonCode(input.reasonCode),
    evidenceRefs: boundedList(input.evidenceRefs, true),
    milestones: boundedList(input.milestones, false),
    limitations: boundedList(input.limitations, false),
    usage: input.usage === 'observed' ? 'observed' : 'unknown',
    effects: input.effects === 'observed' ? 'observed' : 'unknown',
  });
}
