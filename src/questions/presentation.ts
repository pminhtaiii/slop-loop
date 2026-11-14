/** Deterministic, bounded rendering for already validated repository answers. */
import type { QuestionCitationV1, QuestionClaimV1, QuestionLineRangeV1 } from '../contracts/questions/contracts.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import type { QuestionBudgetRefusalCodeV1 } from './budget.ts';
import type { QuestionEvidenceRegistryV1 } from './evidence.ts';

export interface ValidatedQuestionPresentationV1 {
  readonly claims: readonly QuestionClaimV1[];
  readonly citations: readonly QuestionCitationV1[];
  readonly limitations: readonly string[];
}

export type QuestionPresentationResultV1 =
  | { readonly kind: 'delivered'; readonly claims: readonly QuestionClaimV1[]; readonly citations: readonly QuestionCitationV1[]; readonly limitations: readonly string[]; readonly text: string }
  | { readonly kind: 'failed'; readonly reasonCode: 'invalid-citation' | 'protected-content' | 'render-limit' }
  | { readonly kind: 'budget-exhausted'; readonly reasonCode: QuestionBudgetRefusalCodeV1 }
  | { readonly kind: 'stale-repository'; readonly reasonCode: 'binding-mismatch' | 'source-mismatch' }
  | { readonly kind: 'cancelled'; readonly reasonCode: 'cancelled' }
  | { readonly kind: 'blocked'; readonly reasonCode: 'owner-denied' | 'owner-unavailable' };

/** Run final evidence validation and admitted binding recheck before returning source-bearing output. */
export async function presentQuestionAnswer(registry: QuestionEvidenceRegistryV1, proposal: unknown, control: QuestionRepositoryOperationControl): Promise<QuestionPresentationResultV1> {
  return await registry.present(proposal, control);
}

/** @internal Called only after the evidence registry has resolved every citation to an issued span. */
export function renderValidatedQuestionPresentation(input: ValidatedQuestionPresentationV1): string | undefined {
  const citationByReference = new Map<string, QuestionCitationV1>();
  for (const citation of input.citations) citationByReference.set(citationKey(citation.evidenceId, citation.range), citation);
  const lines: string[] = [];
  for (const claim of input.claims) {
    const refs: string[] = [];
    for (const reference of claim.evidence) {
      const citation = citationByReference.get(citationKey(reference.evidenceId, reference.range));
      if (!citation) return undefined;
      refs.push(formatCitation(citation.path, citation.range));
    }
    const label = claim.kind === 'inference' ? 'Inference' : 'Observation';
    lines.push(label + ': ' + escapeMarkdownText(claim.text) + ' [' + refs.join(', ') + ']');
  }
  for (const limitation of input.limitations) lines.push('Limitation: ' + escapeMarkdownText(limitation));
  return lines.length === 0 ? undefined : lines.join('\n');
}

function formatCitation(path: string, range: QuestionLineRangeV1): string {
  return codeSpan(path + ':L' + range.startLine + '-L' + range.endLine);
}

function codeSpan(value: string): string {
  let longestRun = 0;
  for (const match of value.matchAll(/`+/gu)) longestRun = Math.max(longestRun, match[0].length);
  const fence = '`'.repeat(longestRun + 1);
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return fence + padding + value + padding + fence;
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/[\\`*_{}\[\]()#+\-.!|~]/gu, '\\$&');
}

function citationKey(evidenceId: string, range: QuestionLineRangeV1): string {
  return evidenceId + ':' + range.startLine + ':' + range.endLine;
}
