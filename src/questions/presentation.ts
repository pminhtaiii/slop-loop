/** Deterministic, bounded rendering for already validated repository answers. */
import type { ClarifyQuestionDecisionV1, QuestionCitationV1, QuestionClaimV1, QuestionIdentityV1, QuestionLineRangeV1, QuestionResultV1, QuestionUsageV1 } from '../contracts/questions/contracts.ts';
import { containsProtectedContent } from '../foundation/docker-workspace-policy.ts';
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

/** Pure bounded conversation projection. It grants no source or continuation authority. */
export function presentQuestionClarification(identity: QuestionIdentityV1, usage: QuestionUsageV1, decision: ClarifyQuestionDecisionV1, round: number, maxBytes: number): QuestionResultV1 {
  const question = safeConversationText(decision.question);
  const explanation = safeConversationText(decision.explanation);
  const unresolvedReferents = decision.unresolvedReferents.map(safeConversationText);
  const base = { schemaVersion: 'repository-question/1' as const, identity, usage };
  if (!question || !explanation || unresolvedReferents.some(value => value === undefined)) return Object.freeze({ ...base, kind: 'failed', reasonCode: 'protected-content' });
  const result: QuestionResultV1 = Object.freeze({
    ...base,
    kind: 'awaiting-clarification',
    clarification: Object.freeze({ clarificationId: 'clarification-' + round, round, question, explanation, unresolvedReferents: Object.freeze(unresolvedReferents as string[]) }),
  });
  return Buffer.byteLength(JSON.stringify(result)) <= maxBytes ? result : Object.freeze({ ...base, kind: 'failed', reasonCode: 'render-limit' });
}

/** Claim-free insufficiency needs no source IO; supplied claims must already have passed the owning registry. */
export function presentQuestionInsufficientEvidence(
  identity: QuestionIdentityV1,
  usage: QuestionUsageV1,
  explanation: string,
  maxBytes: number,
  supported: ValidatedQuestionPresentationV1 = { claims: [], citations: [], limitations: [] },
): QuestionResultV1 {
  const clean = safeConversationText(explanation);
  const base = { schemaVersion: 'repository-question/1' as const, identity, usage };
  if (!clean) return Object.freeze({ ...base, kind: 'failed', reasonCode: 'protected-content' });
  const result: QuestionResultV1 = Object.freeze({
    ...base,
    kind: 'insufficient-evidence',
    explanation: clean,
    claims: Object.freeze([...supported.claims]),
    citations: Object.freeze([...supported.citations]),
    limitations: Object.freeze([...supported.limitations]),
  });
  return Buffer.byteLength(JSON.stringify(result)) <= maxBytes ? result : Object.freeze({ ...base, kind: 'failed', reasonCode: 'render-limit' });
}

function safeConversationText(input: string): string | undefined {
  const clean = input
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return clean && !containsProtectedContent(input) && !containsProtectedContent(clean) ? clean : undefined;
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
