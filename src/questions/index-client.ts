/** Bounded host waits and native worker transport. Caller startup cancellation never owns shared startup. */
import { Worker } from 'node:worker_threads';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import type { IndexCommand, IndexReply, QuestionIndexFailure, QuestionIndexOptions } from './index-types.ts';

const unavailable = (): QuestionIndexFailure => ({ status: 'unavailable', reasonCode: 'store-unavailable' });

/** Bounds an uncooperative boundary and always releases its timer and abort listener. */
export async function waitForIndexControl<T>(pending: Promise<T>, control: QuestionRepositoryOperationControl): Promise<T | QuestionIndexFailure> {
  if (control.signal.aborted || Date.now() >= control.deadlineEpochMs) {
    // The owner may have started before control was denied; observe its eventual
    // rejection without replacing the already-authoritative cancellation result.
    void pending.catch(() => undefined);
    return control.signal.aborted ? { status: 'cancelled', reasonCode: 'cancelled' } : { status: 'exhausted', reasonCode: 'deadline' };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<QuestionIndexFailure>(resolve => {
        abort = () => resolve({ status: 'cancelled', reasonCode: 'cancelled' });
        control.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => resolve({ status: 'exhausted', reasonCode: 'deadline' }), Math.max(1, control.deadlineEpochMs - Date.now()));
        if (control.signal.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    control.signal.removeEventListener('abort', abort);
  }
}

export function createIndexClient(
  options: Pick<QuestionIndexOptions, 'databasePath' | 'targetRoots' | 'limits'>,
  onStop: () => void,
): {
  readonly rpc: (command: IndexCommand, control: QuestionRepositoryOperationControl) => Promise<IndexReply>;
  readonly stop: () => Promise<number>;
  readonly running: () => boolean;
} {
  let worker: Worker | undefined;
  let start: Promise<boolean> | undefined;
  let nextId = 1;
  const pending = new Map<number, (reply: IndexReply) => void>();
  async function stop(): Promise<number> {
    onStop();
    const running = worker;
    worker = undefined;
    start = undefined;
    for (const finish of pending.values()) finish(unavailable());
    pending.clear();
    return running?.terminate() ?? 0;
  }
  function ready(): Promise<boolean> {
    if (start) return start;
    const created = new Worker(new URL(import.meta.url.endsWith('.ts') ? './index-worker.ts' : './index-worker.js', import.meta.url), {
      workerData: { path: options.databasePath, roots: options.targetRoots, limits: options.limits },
      resourceLimits: { maxOldGenerationSizeMb: Math.floor(options.limits.maxWorkerMemoryBytes / (1024 * 1024)), maxYoungGenerationSizeMb: 4, stackSizeMb: 2 },
    });
    worker = created;
    start = new Promise(resolve => {
      const timer = setTimeout(() => {
        resolve(false);
        if (worker === created) void stop();
      }, options.limits.maxIndexDeadlineMs);
      const failed = () => {
        clearTimeout(timer);
        resolve(false);
        if (worker === created) void stop();
      };
      created.once('error', failed);
      created.once('exit', failed);
      created.on('message', (message: { readonly ready?: boolean; readonly id?: number; readonly result?: IndexReply }) => {
        if (message.ready !== undefined) {
          clearTimeout(timer);
          resolve(message.ready);
        } else if (message.id !== undefined && message.result) {
          const finish = pending.get(message.id);
          pending.delete(message.id);
          finish?.(message.result);
        }
      });
    });
    return start;
  }
  async function rpc(command: IndexCommand, control: QuestionRepositoryOperationControl): Promise<IndexReply> {
    if (control.signal.aborted) return { status: 'cancelled', reasonCode: 'cancelled' };
    if (Date.now() >= control.deadlineEpochMs) return { status: 'exhausted', reasonCode: 'deadline' };
    const started = await waitForIndexControl(ready(), control);
    if (typeof started !== 'boolean') return started;
    if (!started || !worker) return unavailable();
    if (control.signal.aborted) return { status: 'cancelled', reasonCode: 'cancelled' };
    if (Date.now() >= control.deadlineEpochMs) return { status: 'exhausted', reasonCode: 'deadline' };
    const id = nextId++;
    const result = await waitForIndexControl(
      new Promise<IndexReply>(resolve => {
        pending.set(id, resolve);
        worker?.postMessage({ id, command });
      }),
      control,
    );
    pending.delete(id);
    if (result.status === 'cancelled' || (result.status === 'exhausted' && result.reasonCode === 'deadline')) await stop();
    return result;
  }
  return { rpc, stop, running: () => worker !== undefined };
}
