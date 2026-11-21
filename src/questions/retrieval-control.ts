/** Bounds a retrieval operation even when a supplied adapter ignores cancellation. */
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import type { QuestionIndexFailure } from './index.ts';

export async function withRetrievalControl<T>(
  control: QuestionRepositoryOperationControl,
  operation: (bounded: QuestionRepositoryOperationControl) => Promise<T>,
  refuse: (failure: QuestionIndexFailure) => T,
): Promise<T> {
  const deadline = new AbortController();
  const signal = AbortSignal.any([control.signal, deadline.signal]);
  const interrupted = Promise.withResolvers<T>();
  const onAbort = () => interrupted.resolve(refuse(deadline.signal.aborted ? { status: 'exhausted', reasonCode: 'deadline' } : { status: 'cancelled', reasonCode: 'cancelled' }));
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => deadline.abort(), Math.max(0, control.deadlineEpochMs - Date.now()));
  try {
    if (signal.aborted) onAbort();
    return await Promise.race([interrupted.promise, operation({ ...control, signal })]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
