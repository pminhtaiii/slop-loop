/** Guarded navigation, one registry for all final citations, and original-definition expansion hints. */
import type { AdmittedSpanV1, QuestionClosedOutcomeV1, QuestionIndexedChunkV1, QuestionModelDecisionV1 } from '../contracts/questions/contracts.ts';
import { validateDirectoryPage, validateRepositoryBinding, validateSearchPage } from '../contracts/questions/validation.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import type { QuestionBudgetAccountingReceiptV1, QuestionBudgetRefusalCodeV1 } from './budget.ts';
import type { QuestionEvidenceRegistryV1 } from './evidence.ts';
import type { QuestionInvestigationConfiguration } from './graph-types.ts';
import { retrievalInterruption, trackRepositoryWork, withRetrievalControl } from './retrieval-control.ts';
import type { QuestionRepositoryPort } from './repository.ts';
import { sameBinding } from './retrieval-admission.ts';

export type QuestionInvestigationToolResult =
  { readonly status: 'ok'; readonly evidence: readonly AdmittedSpanV1[]; readonly observation: string } | { readonly status: 'stopped'; readonly outcome: QuestionClosedOutcomeV1 };

/** Fixed metadata-only translation. Adapter exception text and source-bearing failure payloads never escape. */
export function questionStop(reason: string): QuestionClosedOutcomeV1 {
  if (reason === 'cancelled') return { kind: 'cancelled', reasonCode: 'cancelled' };
  if (reason === 'binding-mismatch' || reason === 'source-mismatch') return { kind: 'stale-repository', reasonCode: reason };
  if (reason === 'accounting-unknown') return { kind: 'blocked', reasonCode: 'accounting-unknown' };
  if (reason === 'context-limit') return { kind: 'blocked', reasonCode: 'context-limit' };
  if (reason === 'protected-content') return { kind: 'failed', reasonCode: 'protected-content' };
  if (reason === 'invalid-citation') return { kind: 'failed', reasonCode: 'invalid-citation' };
  if (reason === 'denied') return { kind: 'blocked', reasonCode: 'owner-denied' };
  if (reason === 'unavailable' || reason === 'owner-unavailable' || reason === 'busy') return { kind: 'blocked', reasonCode: 'owner-unavailable' };
  if (reason === 'deadline' || reason === 'elapsed-deadline') return { kind: 'budget-exhausted', reasonCode: 'elapsed-deadline' };
  if (['tool-limit', 'model-limit', 'scan-limit', 'output-limit', 'token-limit', 'cost-limit'].includes(reason))
    return { kind: 'budget-exhausted', reasonCode: reason as Extract<QuestionClosedOutcomeV1, { kind: 'budget-exhausted' }>['reasonCode'] };
  return { kind: 'failed', reasonCode: 'invalid-decision' };
}

export function repositoryStop(failure: { readonly status: string; readonly reasonCode?: string }): QuestionClosedOutcomeV1 {
  return questionStop(failure.status === 'denied' ? 'denied' : failure.status === 'unavailable' ? 'unavailable' : (failure.reasonCode ?? failure.status));
}

/** Revalidates the generation around every guarded source operation and final presentation. */
export function investigationRepository(config: QuestionInvestigationConfiguration): QuestionRepositoryPort {
  return Object.freeze({
    ...config.repository,
    async checkBinding(control: QuestionRepositoryOperationControl) {
      const reference = { snapshot: config.snapshot, generationId: config.generationId };
      const before = await config.index.validateCurrent(reference, control);
      const stopped = retrievalInterruption(control);
      if (stopped) return stopped;
      if (before.status !== 'ok') return indexBindingFailure(before);
      const binding = await config.repository.checkBinding(control);
      const after = retrievalInterruption(control);
      if (after) return after;
      if (binding.status !== 'ok') return binding;
      const checked = validateRepositoryBinding(binding.binding);
      if (!checked.ok) return { status: 'unavailable' as const, reasonCode: 'unsupported-adapter' as const };
      if (!sameBinding(checked.value, config.identity.binding)) return { status: 'stale' as const, reasonCode: 'binding-mismatch' as const };
      const current = await config.index.validateCurrent(reference, control);
      const finalStop = retrievalInterruption(control);
      if (finalStop) return finalStop;
      return current.status === 'ok' ? binding : indexBindingFailure(current);
    },
  });
}

/** Admission rechecks the host snapshot's current binding under its own finite reservation before query work. */
export async function admitInvestigationBinding(
  config: QuestionInvestigationConfiguration,
  repository: QuestionRepositoryPort,
  control: QuestionRepositoryOperationControl,
): Promise<QuestionClosedOutcomeV1 | undefined> {
  const admission = config.budget.reserveSnapshotAdmission();
  if (!admission.ok) return questionStop(admission.reasonCode);
  const reservation = admission.value;
  const work = trackRepositoryWork(reservation.maximumWork, control.work);
  const result = await reservation.execute(
    async context => {
      const bounded = { signal: AbortSignal.any([control.signal, context.signal]), deadlineEpochMs: Math.min(control.deadlineEpochMs, Date.now() + context.remainingMs), work: work.meter };
      return withRetrievalControl(
        bounded,
        bounded => repository.checkBinding(bounded),
        failure => failure,
      );
    },
    result => workReceipt(result, work.consumed),
  );
  if (!result.ok) return questionStop(result.reasonCode);
  return result.value.status === 'ok' ? undefined : repositoryStop(result.value);
}

function indexBindingFailure(failure: { readonly status: string; readonly reasonCode: string }) {
  if (failure.status === 'stale') return { status: 'stale' as const, reasonCode: 'binding-mismatch' as const };
  if (failure.status === 'cancelled') return { status: 'cancelled' as const, reasonCode: 'cancelled' as const };
  if (failure.status === 'exhausted') return { status: 'exhausted' as const, reasonCode: failure.reasonCode === 'deadline' ? ('deadline' as const) : ('scan-limit' as const) };
  return { status: 'unavailable' as const, reasonCode: 'unsupported-adapter' as const };
}

/** Every hint is metadata from the frozen ranked definition, never a widened scored hit or citation. */
export function definitionHint(chunk: QuestionIndexedChunkV1, span: AdmittedSpanV1, maxLines: number): string | undefined {
  const definition = chunk.definition;
  if (!definition || span.range.endLine >= definition.endLine) return undefined;
  const startLine = span.range.endLine + 1;
  return JSON.stringify({
    kind: 'definition-continuation',
    path: chunk.path,
    definitionId: definition.definitionId,
    qualifiedName: definition.qualifiedName,
    originalStartLine: definition.startLine,
    originalEndLine: definition.endLine,
    nextRead: { kind: 'read', path: chunk.path, startLine, endLine: Math.min(definition.endLine, startLine + maxLines - 1) },
  });
}

export async function investigateQuestionTool(
  decision: QuestionModelDecisionV1,
  config: QuestionInvestigationConfiguration,
  repository: QuestionRepositoryPort,
  registry: QuestionEvidenceRegistryV1,
  control: QuestionRepositoryOperationControl,
): Promise<QuestionInvestigationToolResult> {
  if (decision.kind === 'read') {
    const read = await registry.readSpan(decision, control);
    if (read.status !== 'ok') return { status: 'stopped', outcome: repositoryStop(read) };
    return { status: 'ok', evidence: [read.span], observation: JSON.stringify({ kind: 'read', path: read.span.path, range: read.span.range, truncation: read.span.truncation }) };
  }
  if (decision.kind !== 'list' && decision.kind !== 'search') return { status: 'stopped', outcome: questionStop('invalid-decision') };
  const admission = config.budget.reserveRepositoryOperation(decision.kind);
  if (!admission.ok) return { status: 'stopped', outcome: questionStop(admission.reasonCode) };
  const reservation = admission.value;
  const work = trackRepositoryWork(reservation.maximumWork, control.work);
  const operation = await reservation.execute(
    async context => {
      const bounded = { signal: AbortSignal.any([control.signal, context.signal]), deadlineEpochMs: Math.min(control.deadlineEpochMs, Date.now() + context.remainingMs), work: work.meter };
      return withRetrievalControl(
        bounded,
        async bounded => {
          const current = await repository.checkBinding(bounded);
          const stop = retrievalInterruption(bounded);
          if (stop) return stop;
          if (current.status !== 'ok') return current;
          const result = decision.kind === 'list' ? await repository.listDirectory(decision, bounded) : await repository.searchLiteral(decision, bounded);
          const after = retrievalInterruption(bounded);
          if (after) return after;
          return result;
        },
        failure => failure,
      );
    },
    result => workReceipt(result, work.consumed),
  );
  if (!operation.ok) return { status: 'stopped', outcome: questionStop(operation.reasonCode) };
  if (decision.kind === 'list') {
    const checked = validateDirectoryPage(operation.value, config.profile.repository);
    if (!checked.ok) return { status: 'stopped', outcome: questionStop('unavailable') };
    if (checked.value.status !== 'ok') return { status: 'stopped', outcome: repositoryStop(checked.value) };
    return { status: 'ok', evidence: [], observation: JSON.stringify({ kind: 'list', ...checked.value }) };
  }
  const checked = validateSearchPage(operation.value, config.profile.repository);
  if (!checked.ok) return { status: 'stopped', outcome: questionStop('unavailable') };
  if (checked.value.status !== 'ok') return { status: 'stopped', outcome: repositoryStop(checked.value) };
  const evidence: AdmittedSpanV1[] = [];
  for (const hit of checked.value.hits) {
    const read = await registry.readSpan({ path: hit.span.path, ...hit.span.range }, control);
    if (read.status !== 'ok') return { status: 'stopped', outcome: repositoryStop(read) };
    evidence.push(read.span);
  }
  return {
    status: 'ok',
    evidence,
    observation: JSON.stringify({
      kind: 'search',
      query: decision.query,
      coverage: checked.value.coverage,
      omissionReasons: checked.value.omissionReasons,
      nextCursor: checked.value.nextCursor,
      hits: checked.value.hits.map(hit => ({ path: hit.span.path, line: hit.line, column: hit.column })),
    }),
  };
}

function workReceipt(result: { readonly status: string; readonly reasonCode?: string }, work: unknown): QuestionBudgetAccountingReceiptV1 {
  if (result.status === 'exhausted') {
    const reason = result.reasonCode;
    if (reason === 'deadline' || reason === 'scan-limit' || reason === 'output-limit') return { kind: 'work-exhausted', work, reasonCode: reason === 'deadline' ? 'elapsed-deadline' : reason };
  }
  return { kind: 'work', work };
}

export function budgetStop(status: string, reasonCode?: QuestionBudgetRefusalCodeV1): QuestionClosedOutcomeV1 {
  return questionStop(reasonCode ?? (status === 'blocked' ? 'accounting-unknown' : status === 'cancelled' ? 'cancelled' : 'scan-limit'));
}
