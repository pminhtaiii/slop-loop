/** Persistent derived index: guarded preparation on the host, atomic publication in an isolated SQLite worker. */
import { createIndexClient, waitForIndexControl } from './index-client.ts';
import { createIndexRefresh } from './index-refresh.ts';
import type { SourceSnapshotV1 } from '../contracts/questions/contracts.ts';
import { validateQuestionIndexGeneration } from '../contracts/questions/validation.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import { admittedSnapshot, indexOptions, matches, validView } from './index-admission.ts';
import type { IndexCommand, IndexReply, QuestionIndex, QuestionIndexFailure, QuestionIndexOptions, QuestionIndexReadResult, QuestionIndexReference } from './index-types.ts';
export type {
  QuestionIndex,
  QuestionIndexOptions,
  QuestionIndexReference,
  QuestionIndexRow,
  QuestionIndexView,
  QuestionIndexReadResult,
  QuestionIndexSyncResult,
  QuestionIndexFailure,
} from './index-types.ts';

const failure = (status: QuestionIndexFailure['status'], reasonCode: QuestionIndexFailure['reasonCode']): QuestionIndexFailure => Object.freeze({ status, reasonCode });
const unavailable = () => failure('unavailable', 'store-unavailable');
/** Options are host-owned; authorize must check a real immutable lease, never merely compare serialized metadata. */
export function createQuestionIndex(input: QuestionIndexOptions): QuestionIndex {
  const options = indexOptions(input);
  const limits = options.limits;
  let closed = false;
  let revoked = false;
  let readers = 0;
  let admitted: string | undefined;
  const client = createIndexClient(options, () => {
    admitted = undefined;
  });
  const stop = () => client.stop();
  const rpc = (command: IndexCommand, control: QuestionRepositoryOperationControl): Promise<IndexReply> =>
    (closed || revoked) && command.kind !== 'cleanup' ? Promise.resolve(unavailable()) : client.rpc(command, control);
  async function guard(snapshot: SourceSnapshotV1, control: QuestionRepositoryOperationControl): Promise<QuestionIndexFailure | undefined> {
    if (closed || revoked) return unavailable();
    if (control.signal.aborted) return failure('cancelled', 'cancelled');
    if (Date.now() >= control.deadlineEpochMs) return failure('exhausted', 'deadline');
    const authorized = await waitForIndexControl(options.authorize(snapshot), control);
    if (closed || revoked) return unavailable();
    if (control.signal.aborted) return failure('cancelled', 'cancelled');
    if (Date.now() >= control.deadlineEpochMs) return failure('exhausted', 'deadline');
    if (typeof authorized !== 'boolean') return authorized;
    return authorized === true ? undefined : failure('stale', 'binding-mismatch');
  }
  async function read(request: QuestionIndexReference & { readonly maxChunks: number }, control: QuestionRepositoryOperationControl): Promise<QuestionIndexReadResult> {
    const snapshot = admittedSnapshot(request?.snapshot);
    if (!snapshot || !Number.isSafeInteger(request.maxChunks) || request.maxChunks < 1) return failure('invalid', 'invalid-request');
    const denied = await guard(snapshot, control);
    if (denied) return denied;
    if (admitted !== request.generationId) return failure('stale', 'generation-incompatible');
    if (readers >= limits.maxConcurrentRetrievalWorkers) return failure('busy', 'busy');
    readers++;
    try {
      const result = await rpc({ kind: 'inspect', maxChunks: Math.min(request.maxChunks, limits.maxExactScanVectors) }, control);
      if (result.status !== 'ok') return result;
      if (!validView(result, options)) return unavailable();
      if (!result.generation || result.generation.generationId !== request.generationId || !matches(result.generation, snapshot, options)) return failure('stale', 'binding-mismatch');
      const current = await confirmCurrent(snapshot, result.generation.generationId, control);
      if (current.status !== 'ok') return current;
      return Object.freeze({
        status: 'ok',
        generation: Object.freeze({ ...result.generation, binding: Object.freeze(result.generation.binding) }),
        files: Object.freeze(result.files.map(file => Object.freeze({ ...file, omissionReasons: Object.freeze(file.omissionReasons) }))),
        chunks: Object.freeze(
          result.chunks.map(row =>
            Object.freeze({
              ...row,
              metadata: Object.freeze({ ...row.metadata, definition: row.metadata.definition ? Object.freeze(row.metadata.definition) : null }),
              vector: Object.freeze(row.vector),
            }),
          ),
        ),
      });
    } finally {
      readers--;
    }
  }
  async function validateCurrent(request: QuestionIndexReference, control: QuestionRepositoryOperationControl): Promise<{ readonly status: 'ok' } | QuestionIndexFailure> {
    const snapshot = admittedSnapshot(request?.snapshot);
    if (!snapshot) return failure('invalid', 'invalid-request');
    const denied = await guard(snapshot, control);
    if (denied) return denied;
    if (admitted !== request.generationId) return failure('stale', 'generation-incompatible');
    const result = await rpc({ kind: 'current' }, control);
    if (result.status !== 'ok') return result;
    if (!result.generation || !validateQuestionIndexGeneration(result.generation).ok) return unavailable();
    if (result.generation.generationId !== request.generationId || !matches(result.generation, snapshot, options)) return failure('stale', 'binding-mismatch');
    return confirmCurrent(snapshot, request.generationId, control);
  }
  async function confirmCurrent(snapshot: SourceSnapshotV1, generationId: string, control: QuestionRepositoryOperationControl): Promise<{ readonly status: 'ok' } | QuestionIndexFailure> {
    const after = await guard(snapshot, control);
    if (after) return after;
    const current = await rpc({ kind: 'current' }, control);
    if (current.status !== 'ok') return current;
    if (
      admitted !== generationId ||
      !current.generation ||
      !validateQuestionIndexGeneration(current.generation).ok ||
      current.generation.generationId !== generationId ||
      !matches(current.generation, snapshot, options)
    )
      return failure('stale', 'binding-mismatch');
    return { status: 'ok' };
  }
  const refresh = createIndexRefresh(options, {
    guard,
    rpc,
    stop,
    closed: () => closed,
    revoked: () => revoked,
    running: () => client.running(),
    admit: id => {
      admitted = id;
    },
  });
  const synchronize = refresh.synchronize;
  return Object.freeze({
    synchronize,
    read,
    validateCurrent,
    async revoke() {
      if (closed) return;
      revoked = true;
      admitted = undefined;
      const control = { signal: new AbortController().signal, deadlineEpochMs: Date.now() + limits.maxIndexDeadlineMs };
      while (Date.now() < control.deadlineEpochMs) {
        const result = await rpc({ kind: 'cleanup', attempt: null, revoke: true }, control);
        if (result.status === 'ok') return;
        if (result.status !== 'busy') throw new Error(`Index cleanup unconfirmed: ${result.status}`);
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(20, Math.max(1, control.deadlineEpochMs - Date.now()))));
      }
      throw new Error('Index cleanup unconfirmed: deadline');
    },
    async close() {
      closed = true;
      const activeAttempt = refresh.activeAttempt();
      if (client.running() && activeAttempt) await rpc({ kind: 'cleanup', attempt: activeAttempt, revoke: false }, { signal: new AbortController().signal, deadlineEpochMs: Date.now() + 1000 });
      await stop();
    },
  });
}
