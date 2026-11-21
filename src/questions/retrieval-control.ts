/** Bounds a retrieval operation even when a supplied adapter ignores cancellation. */
import type { QuestionRepositoryOperationControl, QuestionRepositoryWork, QuestionRepositoryWorkMeter } from '../foundation/repository-types.ts';
type Interruption = { readonly status: 'cancelled'; readonly reasonCode: 'cancelled' } | { readonly status: 'exhausted'; readonly reasonCode: 'deadline' };

export function retrievalInterruption(control: QuestionRepositoryOperationControl): Interruption | undefined {
  return control.signal.aborted ? { status: 'cancelled', reasonCode: 'cancelled' } : Date.now() >= control.deadlineEpochMs ? { status: 'exhausted', reasonCode: 'deadline' } : undefined;
}

export async function withRetrievalControl<T>(
  control: QuestionRepositoryOperationControl,
  operation: (bounded: QuestionRepositoryOperationControl) => Promise<T>,
  refuse: (failure: Interruption) => T,
): Promise<T> {
  const before = retrievalInterruption(control);
  if (before) return refuse(before);
  const deadline = new AbortController();
  const signal = AbortSignal.any([control.signal, deadline.signal]);
  const interrupted = Promise.withResolvers<T>();
  const interruption = (): Interruption | undefined => (deadline.signal.aborted ? { status: 'exhausted', reasonCode: 'deadline' } : retrievalInterruption(control));
  const onAbort = () => {
    const failure = interruption();
    if (failure) interrupted.resolve(refuse(failure));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout>;
  function schedule(): ReturnType<typeof setTimeout> {
    return setTimeout(
      () => {
        if (Date.now() >= control.deadlineEpochMs) deadline.abort();
        else timer = schedule();
      },
      Math.min(2_147_483_647, Math.max(1, Math.ceil(control.deadlineEpochMs - Date.now()))),
    );
  }
  timer = schedule();
  const upstream = control.work;
  const bounded = { ...control, signal };
  if (upstream) {
    bounded.work = {
      remaining: key => (interruption() ? 0 : upstream.remaining(key)),
      charge: work => !interruption() && upstream.charge(work),
    };
  }
  try {
    const result = await Promise.race([interrupted.promise, operation(bounded)]);
    const after = interruption();
    return after ? refuse(after) : result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

export function trackRepositoryWork(
  maximum: QuestionRepositoryWork,
  upstream?: QuestionRepositoryWorkMeter,
): { readonly consumed: QuestionRepositoryWork; readonly meter: QuestionRepositoryWorkMeter } {
  const consumed = { scannedFiles: 0, scannedBytes: 0, returnedBytes: 0 };
  const meter = {
    remaining(key: keyof typeof consumed) {
      return Math.max(0, Math.min((maximum[key] ?? 0) - consumed[key], upstream?.remaining(key) ?? Number.MAX_SAFE_INTEGER));
    },
    charge(work: QuestionRepositoryWork) {
      const keys = ['scannedFiles', 'scannedBytes', 'returnedBytes'] as const;
      if (keys.some(key => !Number.isSafeInteger(work[key] ?? 0) || (work[key] ?? 0) < 0 || (work[key] ?? 0) > meter.remaining(key))) return false;
      if (upstream && !upstream.charge(work)) return false;
      for (const key of keys) consumed[key] += work[key] ?? 0;
      return true;
    },
  };
  return { consumed, meter };
}
