/** Isolates synchronous SQLite and extension calls from the host event loop. */
import { parentPort, workerData } from 'node:worker_threads';
import type { RetrievalResourceLimitsV1 } from '../contracts/questions/contracts.ts';
import type { IndexCommand } from './index-types.ts';
import { openIndexStorage } from './index-storage.ts';

const settings = workerData as { readonly path: string; readonly roots: readonly string[]; readonly limits: RetrievalResourceLimitsV1 };
try {
  const execute = openIndexStorage(settings.path, settings.roots, settings.limits);
  parentPort?.on('message', (message: { readonly id: number; readonly command: IndexCommand }) => {
    parentPort?.postMessage({ id: message.id, result: execute(message.command) });
  });
  parentPort?.postMessage({ ready: true });
} catch {
  parentPort?.postMessage({ ready: false });
}
