/** One scored question turn: host-bound ranking is frozen before guarded evidence admission or absence checks. */
import type { QuestionRankedChunkV1, QuestionRetrievalResultV1, RepositoryToolFailureV1 } from '../contracts/questions/contracts.ts';
import { validateAdmittedSpan, validateQuestionRetrievalRequest } from '../contracts/questions/validation.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import type { QuestionIndexFailure, QuestionIndexView } from './index.ts';
import { admittedView, retrievalOptions, sameBinding, sameIdentity } from './retrieval-admission.ts';
import { recognizeQuestionSymbols } from './retrieval-symbols.ts';
import { computeFileDigest } from '../foundation/docker-workspace-policy.ts';
import { createQuestionEvidenceRegistry } from './evidence.ts';
import type { QuestionIndexedChunkV1 } from '../contracts/questions/contracts.ts';
import type { QuestionPresentationResultV1 } from './presentation.ts';
import type { QuestionRetrievalAdmission } from './retrieval-types.ts';
import { retrievalInterruption, withRetrievalControl } from './retrieval-control.ts';
import { createAbsenceAuthority } from './retrieval-absence.ts';
import type { QuestionRetrieval, QuestionRetrievalOptions } from './retrieval-types.ts';
export type { QuestionRetrieval, QuestionRetrievalOptions, QuestionRetrievalAdmission, QuestionAbsenceResult } from './retrieval-types.ts';

const failed = (status: QuestionIndexFailure['status'], reasonCode: QuestionIndexFailure['reasonCode']): QuestionIndexFailure => Object.freeze({ status, reasonCode });
function stopped(control: QuestionRepositoryOperationControl): QuestionIndexFailure | undefined {
  if (!control || !(control.signal instanceof AbortSignal) || !Number.isFinite(control.deadlineEpochMs)) return failed('invalid', 'invalid-request');
  if (control.signal.aborted) return failed('cancelled', 'cancelled');
  if (Date.now() >= control.deadlineEpochMs) return failed('exhausted', 'deadline');
  return undefined;
}
function response(failure: QuestionIndexFailure): QuestionRetrievalResultV1 {
  return Object.freeze({ schemaVersion: 'question-retrieval/1', ...failure });
}

/** A fresh instance represents one host-selected question run; caller must retain the same task ledger. */
export function createQuestionRetrieval(input: QuestionRetrievalOptions): QuestionRetrieval {
  const options = retrievalOptions(input);
  const lifecycle = new AbortController();
  let closed = false,
    used = false;
  let observation: QuestionRetrievalResultV1 | undefined;
  let view: QuestionIndexView | undefined;
  let query: string | undefined;
  let staticEligible = false,
    staticMatched = false;
  const absence = createAbsenceAuthority(options, () => closed);
  let expected: QuestionIndexedChunkV1 | undefined;
  let admitting = false;
  const registryResult = createQuestionEvidenceRegistry({
    identity: options.identity,
    snapshot: options.snapshot,
    budget: options.budget,
    repositoryLimits: options.repositoryLimits,
    repository: {
      ...options.repository,
      async checkBinding(control) {
        if (closed) return { status: 'unavailable', reasonCode: 'unsupported-adapter' };
        const validateBinding = async (): Promise<RepositoryToolFailureV1 | undefined> => {
          const current = await options.index.validateCurrent({ snapshot: options.snapshot, generationId: options.generationId }, control);
          if (current.status !== 'ok')
            return current.status === 'stale'
              ? { status: 'stale', reasonCode: 'binding-mismatch' }
              : current.status === 'cancelled'
                ? { status: 'cancelled', reasonCode: 'cancelled' }
                : current.status === 'exhausted'
                  ? { status: 'exhausted', reasonCode: current.reasonCode === 'deadline' ? 'deadline' : 'scan-limit' }
                  : { status: 'unavailable', reasonCode: 'unsupported-adapter' };
          return undefined;
        };
        const before = await validateBinding();
        const stop = retrievalInterruption(control);
        if (stop) return stop;
        if (before) return before;
        const binding = await options.repository.checkBinding(control);
        const after = retrievalInterruption(control);
        if (after) return after;
        if (binding.status !== 'ok') return binding;
        const checkedBinding = { ...binding.binding };
        if (!sameBinding(checkedBinding, options.identity.binding)) return { status: 'stale', reasonCode: 'binding-mismatch' };
        return (await validateBinding()) ?? { status: 'ok', binding: checkedBinding };
      },
      async readSpan(request, control) {
        const target = expected;
        if (!target) return { status: 'invalid', reasonCode: 'invalid-request' };
        const result = await options.repository.readSpan(request, control);
        const stop = retrievalInterruption(control);
        if (stop) return stop;
        if (result.status !== 'ok') return result;
        const checkedSpan = validateAdmittedSpan(result.span, options.repositoryLimits);
        if (!checkedSpan.ok) return { status: 'unavailable', reasonCode: 'unsupported-adapter' };
        const span = checkedSpan.value;
        if (
          span.path !== target.path ||
          span.range.startLine !== target.startLine ||
          span.range.endLine !== target.endLine ||
          span.originalByteDigest !== target.originalByteDigest ||
          span.excerptDigest !== target.excerptDigest ||
          computeFileDigest(span.excerpt) !== target.excerptDigest ||
          Buffer.byteLength(span.excerpt) !== target.normalizedByteLength ||
          span.truncation.kind !== 'none'
        )
          return { status: 'stale', reasonCode: 'source-mismatch' };
        const current = await options.index.validateCurrent({ snapshot: options.snapshot, generationId: options.generationId }, control);
        if (current.status !== 'ok') return { status: 'stale', reasonCode: 'binding-mismatch' };
        return { status: 'ok', span };
      },
    },
  });
  if (!registryResult.ok) throw new TypeError('Invalid retrieval evidence context');
  const registry = registryResult.value;
  async function rank(raw: unknown, control: QuestionRepositoryOperationControl): Promise<QuestionRetrievalResultV1> {
    const checked = validateQuestionRetrievalRequest(raw);
    if (
      !checked.ok ||
      !checked.value.queryText.isWellFormed() ||
      Buffer.byteLength(checked.value.queryText) > options.repositoryLimits.maxQueryBytes ||
      !sameIdentity(checked.value.identity, options.identity) ||
      checked.value.generationId !== options.generationId ||
      Object.entries(checked.value.limits).some(([key, value]) => value > options.limits[key as keyof typeof options.limits])
    )
      return response(failed('invalid', 'invalid-request'));
    if (closed) return response(failed('unavailable', 'store-unavailable'));
    if (used) return response(failed('invalid', 'invalid-request'));
    const stop = stopped(control);
    if (stop) return response(stop);
    const reservation = options.budget.reserveRetrievalQuery();
    if (!reservation.ok) return response(failed(reservation.reasonCode === 'cancelled' ? 'cancelled' : 'exhausted', reservation.reasonCode === 'cancelled' ? 'cancelled' : 'scan-limit'));
    used = true;
    let scannedVectors = 0;
    const result = await reservation.value.execute(
      async context => {
        const bounded = {
          signal: AbortSignal.any([control.signal, context.signal, lifecycle.signal]),
          deadlineEpochMs: Math.floor(Math.min(control.deadlineEpochMs, Date.now() + context.remainingMs, Date.now() + checked.value.limits.maxRetrievalDeadlineMs)),
        };
        return withRetrievalControl(
          bounded,
          async bounded => {
            const before = stopped(bounded);
            if (before) return response(before);
            if (closed) return response(failed('unavailable', 'store-unavailable'));
            const counted = options.embedding.count({ kind: 'query', text: checked.value.queryText }, bounded.signal);
            if (counted.status !== 'ok')
              return response(
                failed(
                  counted.status === 'cancelled' ? 'cancelled' : counted.status === 'overflow' ? 'exhausted' : counted.status === 'invalid' ? 'invalid' : 'unavailable',
                  counted.status === 'cancelled' ? 'cancelled' : counted.status === 'overflow' ? 'scan-limit' : counted.status === 'invalid' ? 'invalid-request' : 'store-unavailable',
                ),
              );
            if (!Number.isSafeInteger(counted.tokens) || counted.tokens < 1 || counted.tokens > options.embedding.profile.maxTokens) return response(failed('invalid', 'invalid-request'));
            const maximum = Math.min(checked.value.limits.maxChunks, checked.value.limits.maxExactScanVectors, reservation.value.maximumWork.scannedVectors ?? 0);
            const stored = await options.index.read({ snapshot: options.snapshot, generationId: options.generationId, maxChunks: maximum }, bounded);
            if (stored.status !== 'ok') return response(stored);
            if (Array.isArray(stored.chunks)) scannedVectors = stored.chunks.length;
            const afterRead = stopped(bounded);
            if (afterRead) return response(afterRead);
            if (!Array.isArray(stored.chunks) || !Array.isArray(stored.files)) return response(failed('unavailable', 'store-unavailable'));
            if (
              stored.chunks.length > maximum ||
              stored.files.length > checked.value.limits.maxFiles ||
              stored.chunks.length * (4096 + options.embedding.profile.dimension * 8) + stored.files.length * 1024 > checked.value.limits.maxWorkerMemoryBytes
            )
              return response(failed('exhausted', 'scan-limit'));
            const admitted = admittedView(stored, options);
            if (!admitted) return response(failed('stale', 'generation-incompatible'));
            if (admitted.chunks.length > maximum) return response(failed('exhausted', 'scan-limit'));
            const symbols = await recognizeQuestionSymbols(
              checked.value.queryText,
              admitted.chunks.map(row => row.metadata),
              bounded,
            );
            if (symbols.status !== 'ok') return response(symbols);
            if (options.staticLookup) {
              const lookup = await recognizeQuestionSymbols(options.staticLookup, [], bounded);
              if (lookup.status !== 'ok') return response(lookup);
              staticEligible = lookup.identifiers.length === 1 && lookup.identifiers[0] === options.staticLookup && symbols.identifiers.includes(options.staticLookup);
            }
            const embedded = await options.embedding.embed({ kind: 'query', text: checked.value.queryText }, bounded.signal);
            if (embedded.status !== 'ok')
              return response(
                failed(
                  embedded.status === 'cancelled' ? 'cancelled' : embedded.status === 'overflow' ? 'exhausted' : embedded.status === 'invalid' ? 'invalid' : 'unavailable',
                  embedded.status === 'cancelled' ? 'cancelled' : embedded.status === 'overflow' ? 'scan-limit' : embedded.status === 'invalid' ? 'invalid-request' : 'store-unavailable',
                ),
              );
            const afterEmbedding = stopped(bounded);
            if (afterEmbedding) return response(afterEmbedding);
            if (
              embedded.tokens !== counted.tokens ||
              !Array.isArray(embedded.vector) ||
              embedded.vector.length !== options.embedding.profile.dimension ||
              Array.from(embedded.vector).some(value => !Number.isFinite(value)) ||
              Math.abs(embedded.vector.reduce((sum, value) => sum + value * value, 0) - 1) > 1e-5
            )
              return response(failed('invalid', 'invalid-request'));
            const ranked: QuestionRankedChunkV1[] = [];
            const seen = new Set<string>();
            for (const row of admitted.chunks) {
              const stop = stopped(bounded);
              if (stop) return response(stop);
              if (
                options.staticLookup &&
                options.scope?.includes(row.metadata.path) &&
                row.metadata.kind === 'definition' &&
                (options.staticLookup.includes('.') ? row.metadata.qualifiedSymbolName === options.staticLookup : row.metadata.symbolName === options.staticLookup)
              )
                staticMatched = true;
              if (seen.has(row.metadata.chunkId)) continue;
              seen.add(row.metadata.chunkId);
              const score = Math.max(
                -1,
                Math.min(
                  1,
                  row.vector.reduce((sum, value, i) => sum + value * (embedded.vector[i] ?? 0), 0) /
                    Math.sqrt(row.vector.reduce((sum, value) => sum + value * value, 0) * embedded.vector.reduce((sum, value) => sum + value * value, 0)),
                ),
              );
              const lane =
                row.metadata.kind === 'definition' && symbols.qualified.has(row.metadata.qualifiedSymbolName ?? '')
                  ? 'exact-qualified'
                  : row.metadata.kind === 'definition' && symbols.simple.has(row.metadata.symbolName ?? '')
                    ? 'exact-simple'
                    : 'semantic';
              ranked.push({
                chunkId: row.metadata.chunkId,
                lane,
                rank: 1,
                score,
                path: row.metadata.path,
                revisionDigest: options.identity.binding.revisionDigest,
                originalByteDigest: row.metadata.originalByteDigest,
                excerptDigest: row.metadata.excerptDigest,
                startLine: row.metadata.startLine,
                endLine: row.metadata.endLine,
                normalizedByteLength: row.metadata.normalizedByteLength,
                embeddingInputTokens: row.embeddingInputTokens,
              });
            }
            const tiers = { 'exact-qualified': 2, 'exact-simple': 1, semantic: 0 };
            ranked.sort(
              (a, b) =>
                tiers[b.lane] - tiers[a.lane] ||
                b.score - a.score ||
                (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
                a.startLine - b.startLine ||
                a.endLine - b.endLine ||
                (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0),
            );
            const current = await options.index.validateCurrent({ snapshot: options.snapshot, generationId: options.generationId }, bounded);
            if (current.status !== 'ok') return response(current);
            const after = stopped(bounded);
            if (after) return response(after);
            if (closed) return response(failed('unavailable', 'store-unavailable'));
            view = admitted;
            const base = {
              schemaVersion: 'question-retrieval/1' as const,
              binding: admitted.generation.binding,
              generationId: options.generationId,
              manifestDigest: admitted.generation.manifestDigest,
              configDigest: admitted.generation.configDigest,
              embeddingDigest: admitted.generation.embeddingDigest,
            };
            return ranked.length
              ? Object.freeze({ ...base, status: 'complete' as const, ranked: Object.freeze(ranked.slice(0, 5).map((hit, i) => Object.freeze({ ...hit, rank: i + 1 }))) })
              : Object.freeze({ ...base, status: 'empty' as const, ranked: Object.freeze([]) as readonly [] });
          },
          response,
        );
      },
      value =>
        value.status === 'exhausted'
          ? { kind: 'work-exhausted', work: { scannedVectors }, reasonCode: value.reasonCode === 'deadline' ? 'elapsed-deadline' : 'scan-limit' }
          : { kind: 'work', work: { scannedVectors } },
    );
    if (!result.ok)
      return response(
        failed(result.reasonCode === 'cancelled' ? 'cancelled' : 'exhausted', result.reasonCode === 'cancelled' ? 'cancelled' : result.reasonCode === 'elapsed-deadline' ? 'deadline' : 'scan-limit'),
      );
    observation = result.value;
    if (result.value.status === 'complete' || result.value.status === 'empty') query = checked.value.queryText;
    return result.value;
  }
  async function admit(candidate: unknown, chunkId: string, control: QuestionRepositoryOperationControl): Promise<QuestionRetrievalAdmission> {
    if (candidate !== observation || !observation || observation.status !== 'complete' || !view || !observation.ranked.some(hit => hit.chunkId === chunkId))
      return failed('invalid', 'invalid-request');
    if (closed) return failed('unavailable', 'store-unavailable');
    const stop = stopped(control);
    if (stop) return stop;
    if (admitting) return failed('busy', 'busy');
    const row = view.chunks.find(row => row.metadata.chunkId === chunkId);
    if (!row) return failed('invalid', 'invalid-request');
    admitting = true;
    expected = row.metadata;
    try {
      const result = await registry.readSpan(
        { path: expected.path, startLine: expected.startLine, endLine: expected.endLine },
        { ...control, signal: AbortSignal.any([control.signal, lifecycle.signal]) },
      );
      if (result.status === 'ok') return result;
      if (result.status === 'stale') return failed('stale', 'binding-mismatch');
      if (result.status === 'cancelled') return failed('cancelled', 'cancelled');
      if (result.status === 'exhausted' || result.status === 'budget-exhausted')
        return failed(result.reasonCode === 'cancelled' ? 'cancelled' : 'exhausted', result.reasonCode === 'cancelled' ? 'cancelled' : result.reasonCode === 'deadline' ? 'deadline' : 'scan-limit');
      return failed('unavailable', 'store-unavailable');
    } finally {
      expected = undefined;
      admitting = false;
    }
  }
  return Object.freeze({
    rank,
    admit,
    async present(proposal: unknown, control: QuestionRepositoryOperationControl): Promise<QuestionPresentationResultV1> {
      if (closed) return { kind: 'cancelled', reasonCode: 'cancelled' };
      const stop = stopped(control);
      if (stop) return stop.reasonCode === 'deadline' ? { kind: 'budget-exhausted', reasonCode: 'elapsed-deadline' } : { kind: 'cancelled', reasonCode: 'cancelled' };
      const result = await registry.present(proposal, { ...control, signal: AbortSignal.any([control.signal, lifecycle.signal]) });
      return closed && result.kind === 'delivered' ? { kind: 'cancelled', reasonCode: 'cancelled' } : result;
    },
    proveAbsence(control: QuestionRepositoryOperationControl) {
      const stop = stopped(control);
      if (stop) return Promise.resolve(stop);
      return absence.prove(view, query, staticEligible, staticMatched, { ...control, signal: AbortSignal.any([control.signal, lifecycle.signal]) });
    },
    validateAbsence(receipt: unknown, control: QuestionRepositoryOperationControl) {
      const stop = stopped(control);
      if (stop) return Promise.resolve(stop);
      return absence.validate(receipt, { ...control, signal: AbortSignal.any([control.signal, lifecycle.signal]) });
    },
    close() {
      closed = true;
      lifecycle.abort();
    },
  });
}
