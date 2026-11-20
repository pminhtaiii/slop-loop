/** Host-only scoped static absence authority, with complete guarded scans and per-task accounting. */
import type { QuestionAbsenceReceiptV1 } from '../contracts/questions/contracts.ts';
import { validateSearchPage } from '../contracts/questions/validation.ts';
import { computeFileDigest } from '../foundation/docker-workspace-policy.ts';
import type { QuestionRepositoryOperationControl, QuestionRepositoryWork } from '../foundation/repository-types.ts';
import type { QuestionIndexFailure, QuestionIndexView } from './index.ts';
import { sameBinding } from './retrieval-admission.ts';
import type { QuestionAbsenceResult, QuestionRetrievalOptions } from './retrieval-types.ts';
import type { QuestionBudgetWorkV1 } from './budget.ts';

function track(maximum: QuestionBudgetWorkV1, control: QuestionRepositoryOperationControl) {
  const consumed = { scannedFiles: 0, scannedBytes: 0, returnedBytes: 0 };
  const meter = {
    remaining(key: keyof typeof consumed) {
      return Math.max(0, Math.min((maximum[key] ?? 0) - consumed[key], control.work?.remaining(key) ?? Number.MAX_SAFE_INTEGER));
    },
    charge(work: QuestionRepositoryWork) {
      const keys = ['scannedFiles', 'scannedBytes', 'returnedBytes'] as const;
      if (keys.some(key => !Number.isSafeInteger(work[key] ?? 0) || (work[key] ?? 0) < 0 || (work[key] ?? 0) > meter.remaining(key))) return false;
      if (control.work && !control.work.charge(work)) return false;
      for (const key of keys) consumed[key] += work[key] ?? 0;
      return true;
    },
  };
  return { consumed, meter };
}

function stopped(control: QuestionRepositoryOperationControl): QuestionIndexFailure | undefined {
  return control.signal.aborted ? { status: 'cancelled', reasonCode: 'cancelled' } : Date.now() >= control.deadlineEpochMs ? { status: 'exhausted', reasonCode: 'deadline' } : undefined;
}
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
    const before = await current(control);
    if (before.status !== 'ok') return before;
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
        const stop = stopped(control);
        if (stop) return stop;
        const admission = options.budget.reserveRepositoryOperation('search');
        if (!admission.ok) return { status: admission.reasonCode === 'cancelled' ? 'cancelled' : 'exhausted', reasonCode: admission.reasonCode === 'cancelled' ? 'cancelled' : 'scan-limit' };
        const work = track(admission.value.maximumWork, control);
        const execution = await admission.value.execute(
          async context => {
            const bounded = {
              signal: AbortSignal.any([context.signal, control.signal]),
              deadlineEpochMs: Math.floor(Math.min(control.deadlineEpochMs, Date.now() + context.remainingMs)),
              work: work.meter,
            };
            const fresh = await current(bounded);
            if (fresh.status !== 'ok') return fresh;
            const binding = await options.repository.checkBinding(bounded);
            const stop = stopped(bounded);
            if (stop) return stop;
            if (isClosed()) return { status: 'unavailable' as const, reasonCode: 'store-unavailable' as const };
            if (binding.status !== 'ok') return binding;
            if (!sameBinding(binding.binding, options.identity.binding)) return { status: 'stale' as const, reasonCode: 'binding-mismatch' as const };
            return options.repository.searchLiteral({ query: options.staticLookup ?? '', pathPrefix: path }, bounded);
          },
          () => ({ kind: 'work', work: work.consumed }),
        );
        if (!execution.ok) return { status: execution.reasonCode === 'cancelled' ? 'cancelled' : 'exhausted', reasonCode: execution.reasonCode === 'cancelled' ? 'cancelled' : 'scan-limit' };
        const parsed = validateSearchPage(execution.value, options.repositoryLimits);
        if (!parsed.ok) return { status: 'unavailable', reasonCode: 'store-unavailable' };
        if (parsed.value.status !== 'ok')
          return parsed.value.status === 'stale'
            ? { status: 'stale', reasonCode: 'binding-mismatch' }
            : parsed.value.status === 'cancelled'
              ? { status: 'cancelled', reasonCode: 'cancelled' }
              : { status: 'insufficient', reasonCode: 'incomplete-coverage' };
        if (parsed.value.hits.length) return { status: 'insufficient', reasonCode: 'matches-found' };
        if (parsed.value.coverage !== 'complete' || parsed.value.omissionReasons.length || parsed.value.nextCursor !== undefined) return { status: 'insufficient', reasonCode: 'incomplete-coverage' };
      }
      const after = await confirm(control);
      if (after.status !== 'ok') return after;
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
    const work = track(admission.value.maximumWork, control);
    const execution = await admission.value.execute(
      async context => {
        const bounded = {
          signal: AbortSignal.any([context.signal, control.signal]),
          deadlineEpochMs: Math.floor(Math.min(control.deadlineEpochMs, Date.now() + context.remainingMs)),
          work: work.meter,
        };
        const fresh = await current(bounded);
        if (fresh.status !== 'ok') return fresh;
        const binding = await options.repository.checkBinding(bounded);
        return binding.status === 'ok' && sameBinding(binding.binding, options.identity.binding)
          ? { status: 'ok' as const }
          : binding.status === 'cancelled'
            ? { status: 'cancelled' as const, reasonCode: 'cancelled' as const }
            : { status: 'stale' as const, reasonCode: 'binding-mismatch' as const };
      },
      () => ({ kind: 'work', work: work.consumed }),
    );
    return execution.ok ? execution.value : { status: execution.reasonCode === 'cancelled' ? 'cancelled' : 'exhausted', reasonCode: execution.reasonCode === 'cancelled' ? 'cancelled' : 'scan-limit' };
  }
  return Object.freeze({ prove, validate });
}
