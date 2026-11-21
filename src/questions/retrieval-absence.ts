/** Host-only scoped static absence authority, with complete guarded scans and per-task accounting. */
import type { QuestionAbsenceReceiptV1 } from '../contracts/questions/contracts.ts';
import { scanExactFilePage } from './retrieval-file-scan.ts';
import { computeFileDigest } from '../foundation/docker-workspace-policy.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import type { QuestionIndexFailure, QuestionIndexView } from './index.ts';
import { sameBinding } from './retrieval-admission.ts';
import type { QuestionAbsenceResult, QuestionRetrievalOptions } from './retrieval-types.ts';
import { retrievalInterruption as stopped, trackRepositoryWork, withRetrievalControl } from './retrieval-control.ts';

export interface QuestionAbsenceAuthority {
  prove(view: QuestionIndexView | undefined, query: string | undefined, eligible: boolean, matched: boolean, control: QuestionRepositoryOperationControl): Promise<QuestionAbsenceResult>;
  validate(receipt: unknown, control: QuestionRepositoryOperationControl): Promise<{ readonly status: 'ok' } | QuestionIndexFailure>;
}
export function createAbsenceAuthority(options: QuestionRetrievalOptions, isClosed: () => boolean): QuestionAbsenceAuthority {
  let issued: QuestionAbsenceReceiptV1 | undefined;
  let proving = false;
  async function current(control: QuestionRepositoryOperationControl): Promise<{ readonly status: 'ok' } | QuestionIndexFailure> {
    if (isClosed()) return { status: 'unavailable', reasonCode: 'store-unavailable' };
    const stop = stopped(control);
    if (stop) return stop;
    if (options.budget.snapshot().status !== 'open')
      return { status: options.budget.snapshot().status === 'cancelled' ? 'cancelled' : 'exhausted', reasonCode: options.budget.snapshot().status === 'cancelled' ? 'cancelled' : 'scan-limit' };
    const result = await options.index.validateCurrent({ snapshot: options.snapshot, generationId: options.generationId }, control);
    return stopped(control) ?? (isClosed() ? { status: 'unavailable', reasonCode: 'store-unavailable' } : result);
  }
  async function prove(
    view: QuestionIndexView | undefined,
    query: string | undefined,
    eligible: boolean,
    matched: boolean,
    control: QuestionRepositoryOperationControl,
  ): Promise<QuestionAbsenceResult> {
    if (!eligible || !options.staticLookup || !view || query === undefined) return { status: 'insufficient', reasonCode: 'not-static' };
    if (isClosed()) return { status: 'unavailable', reasonCode: 'store-unavailable' };
    const stop = stopped(control);
    if (stop) return stop;
    // Native freshness checks run only inside an admitted search or final-validation reservation.
    if (proving) return { status: 'busy', reasonCode: 'busy' };
    if (issued) {
      const fresh = await confirm(control);
      return fresh.status === 'ok' ? { status: 'ok', receipt: issued } : fresh;
    }
    const scope = options.scope ?? [];
    const files = view.files.filter(file => scope.includes(file.path));
    if (files.length !== scope.length || files.some(file => file.coverage !== 'complete' || file.omissionReasons.length)) return { status: 'insufficient', reasonCode: 'incomplete-coverage' };
    if (matched) return { status: 'insufficient', reasonCode: 'matches-found' };
    proving = true;
    try {
      for (const path of scope) {
        let nextLine: number | undefined = 1;
        while (nextLine !== undefined) {
          const stop = stopped(control);
          if (stop) return stop;
          const admission = options.budget.reserveRepositoryOperation('read');
          if (!admission.ok) return { status: admission.reasonCode === 'cancelled' ? 'cancelled' : 'exhausted', reasonCode: admission.reasonCode === 'cancelled' ? 'cancelled' : 'scan-limit' };
          const work = trackRepositoryWork(admission.value.maximumWork, control.work);
          const execution = await admission.value.execute(
            async context => {
              const bounded = {
                signal: AbortSignal.any([context.signal, control.signal]),
                deadlineEpochMs: Math.floor(Math.min(control.deadlineEpochMs, Date.now() + context.remainingMs)),
                work: work.meter,
              };
              return withRetrievalControl(
                bounded,
                async bounded => {
                  const fresh = await current(bounded);
                  if (fresh.status !== 'ok') return fresh;
                  const binding = await options.repository.checkBinding(bounded);
                  const stop = stopped(bounded);
                  if (stop) return stop;
                  if (isClosed()) return { status: 'unavailable' as const, reasonCode: 'store-unavailable' as const };
                  if (binding.status !== 'ok')
                    return binding.status === 'cancelled'
                      ? { status: 'cancelled' as const, reasonCode: 'cancelled' as const }
                      : binding.status === 'stale'
                        ? { status: 'stale' as const, reasonCode: 'binding-mismatch' as const }
                        : { status: 'insufficient' as const, reasonCode: 'incomplete-coverage' as const };
                  if (!sameBinding(binding.binding, options.identity.binding)) return { status: 'stale' as const, reasonCode: 'binding-mismatch' as const };
                  return scanExactFilePage(options, path, nextLine ?? 1, bounded);
                },
                failure => failure,
              );
            },
            () => ({ kind: 'work', work: work.consumed }),
          );
          if (!execution.ok) return { status: execution.reasonCode === 'cancelled' ? 'cancelled' : 'exhausted', reasonCode: execution.reasonCode === 'cancelled' ? 'cancelled' : 'scan-limit' };
          const result = execution.value;
          if (result.status !== 'ok') return result;
          nextLine = result.nextLine;
        }
      }
      const after = await confirm(control);
      if (after.status !== 'ok') return after;
      const interrupted = stopped(control);
      if (interrupted) return interrupted;
      issued = Object.freeze({
        schemaVersion: 'question-retrieval/1',
        binding: options.identity.binding,
        snapshotId: options.snapshot.snapshotId,
        generationId: options.generationId,
        manifestDigest: options.snapshot.manifestDigest,
        normalizedQueryDigest: computeFileDigest(query.trim().replace(/\s+/gu, ' ')),
        scope: Object.freeze([...scope]),
        exactDefinitionScan: 'complete',
        guardedLiteralScan: 'complete',
        exactDefinitionMatchCount: 0,
        guardedLiteralMatchCount: 0,
        omissionReasons: Object.freeze([]) as readonly [],
      });
      return { status: 'ok', receipt: issued };
    } finally {
      proving = false;
    }
  }
  async function validate(receipt: unknown, control: QuestionRepositoryOperationControl): Promise<{ readonly status: 'ok' } | QuestionIndexFailure> {
    if (!issued || receipt !== issued) return { status: 'invalid', reasonCode: 'invalid-request' };
    return confirm(control);
  }
  async function confirm(control: QuestionRepositoryOperationControl): Promise<{ readonly status: 'ok' } | QuestionIndexFailure> {
    const stop = stopped(control);
    if (stop) return stop;
    if (isClosed()) return { status: 'unavailable', reasonCode: 'store-unavailable' };
    const admission = options.budget.reserveFinalValidation();
    if (!admission.ok) return { status: admission.reasonCode === 'cancelled' ? 'cancelled' : 'exhausted', reasonCode: admission.reasonCode === 'cancelled' ? 'cancelled' : 'scan-limit' };
    const work = trackRepositoryWork(admission.value.maximumWork, control.work);
    const execution = await admission.value.execute(
      async context => {
        const bounded = {
          signal: AbortSignal.any([context.signal, control.signal]),
          deadlineEpochMs: Math.floor(Math.min(control.deadlineEpochMs, Date.now() + context.remainingMs)),
          work: work.meter,
        };
        return withRetrievalControl(
          bounded,
          async bounded => {
            const fresh = await current(bounded);
            if (fresh.status !== 'ok') return fresh;
            const binding = await options.repository.checkBinding(bounded);
            const matched = binding.status === 'ok' && sameBinding(binding.binding, options.identity.binding);
            const after = await current(bounded);
            if (after.status !== 'ok') return after;
            return matched
              ? { status: 'ok' as const }
              : binding.status === 'cancelled'
                ? { status: 'cancelled' as const, reasonCode: 'cancelled' as const }
                : { status: 'stale' as const, reasonCode: 'binding-mismatch' as const };
          },
          failure => failure,
        );
      },
      () => ({ kind: 'work', work: work.consumed }),
    );
    return execution.ok ? execution.value : { status: execution.reasonCode === 'cancelled' ? 'cancelled' : 'exhausted', reasonCode: execution.reasonCode === 'cancelled' ? 'cancelled' : 'scan-limit' };
  }
  return Object.freeze({ prove, validate });
}
