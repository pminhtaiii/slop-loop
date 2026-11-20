/** Persistent derived index: guarded preparation on the host, atomic publication in an isolated SQLite worker. */
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { QuestionIndexGenerationV1, SourceSnapshotV1 } from '../contracts/questions/contracts.ts';
import { validateQuestionIndexGeneration } from '../contracts/questions/validation.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import { buildQuestionChunks } from './chunks.ts';
import { admittedSnapshot, compatible, indexOptions, matches, trackIndexWork, validView } from './index-admission.ts';
import type { QuestionBudgetWorkV1 } from './budget.ts';
import type {
  IndexCommand,
  IndexReply,
  QuestionIndex,
  QuestionIndexFailure,
  QuestionIndexOptions,
  QuestionIndexReadResult,
  QuestionIndexReference,
  QuestionIndexRow,
  QuestionIndexSyncResult,
} from './index-types.ts';
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
  let worker: Worker | undefined;
  let start: Promise<boolean> | undefined;
  let closed = false;
  let revoked = false;
  let writing = false;
  let activeAttempt: string | undefined;
  let readers = 0;
  let admitted: string | undefined;
  let nextId = 1;
  const pending = new Map<number, (result: IndexReply) => void>();

  function stop(): Promise<number> {
    admitted = undefined;
    const running = worker;
    worker = undefined;
    start = undefined;
    for (const done of pending.values()) done(unavailable());
    pending.clear();
    return running?.terminate() ?? Promise.resolve(0);
  }
  async function ready(control: QuestionRepositoryOperationControl): Promise<boolean> {
    if (worker && start) return start;
    const created = new Worker(new URL(import.meta.url.endsWith('.ts') ? './index-worker.ts' : './index-worker.js', import.meta.url), {
      workerData: { path: options.databasePath, roots: options.targetRoots, limits },
      resourceLimits: { maxOldGenerationSizeMb: Math.floor(limits.maxWorkerMemoryBytes / (1024 * 1024)), maxYoungGenerationSizeMb: 4, stackSizeMb: 2 },
    });
    worker = created;
    start = new Promise(resolve => {
      const timer = setTimeout(
        () => {
          resolve(false);
          void stop();
        },
        Math.max(1, control.deadlineEpochMs - Date.now()),
      );
      created.once('error', () => {
        clearTimeout(timer);
        resolve(false);
        void stop();
      });
      created.once('exit', () => {
        clearTimeout(timer);
        resolve(false);
        if (worker === created) void stop();
      });
      created.on('message', (message: { readonly ready?: boolean; readonly id?: number; readonly result?: IndexReply }) => {
        if (message.ready !== undefined) {
          clearTimeout(timer);
          resolve(message.ready);
        } else if (message.id !== undefined && message.result) {
          const done = pending.get(message.id);
          pending.delete(message.id);
          done?.(message.result);
        }
      });
    });
    return start;
  }
  async function rpc(command: IndexCommand, control: QuestionRepositoryOperationControl): Promise<IndexReply> {
    if ((closed || revoked) && command.kind !== 'cleanup') return unavailable();
    if (control.signal.aborted) return failure('cancelled', 'cancelled');
    if (Date.now() >= control.deadlineEpochMs) return failure('exhausted', 'deadline');
    if (!(await ready(control)) || !worker) return unavailable();
    if ((closed || revoked) && command.kind !== 'cleanup') return unavailable();
    if (control.signal.aborted) return failure('cancelled', 'cancelled');
    if (Date.now() >= control.deadlineEpochMs) return failure('exhausted', 'deadline');
    return new Promise(resolve => {
      const id = nextId++;
      const finish = (result: IndexReply) => {
        clearTimeout(timer);
        control.signal.removeEventListener('abort', abort);
        pending.delete(id);
        resolve(result);
      };
      const abort = () => {
        finish(failure('cancelled', 'cancelled'));
        void stop();
      };
      const timer = setTimeout(
        () => {
          finish(failure('exhausted', 'deadline'));
          void stop();
        },
        Math.max(1, control.deadlineEpochMs - Date.now()),
      );
      pending.set(id, finish);
      control.signal.addEventListener('abort', abort, { once: true });
      worker?.postMessage({ id, command });
      if (control.signal.aborted) abort();
    });
  }
  async function guard(snapshot: SourceSnapshotV1, control: QuestionRepositoryOperationControl): Promise<QuestionIndexFailure | undefined> {
    if (closed || revoked) return unavailable();
    if (control.signal.aborted) return failure('cancelled', 'cancelled');
    if (Date.now() >= control.deadlineEpochMs) return failure('exhausted', 'deadline');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const authorized = await Promise.race([
      options.authorize(snapshot),
      new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), Math.max(1, control.deadlineEpochMs - Date.now()));
      }),
    ]).finally(() => clearTimeout(timer));
    if (closed || revoked) return unavailable();
    if (control.signal.aborted) return failure('cancelled', 'cancelled');
    if (Date.now() >= control.deadlineEpochMs) return failure('exhausted', 'deadline');
    return authorized ? undefined : failure('stale', 'binding-mismatch');
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
      const after = await guard(snapshot, control);
      if (after) return after;
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
    return (await guard(snapshot, control)) ?? { status: 'ok' };
  }
  async function synchronize(request: Parameters<QuestionIndex['synchronize']>[0], control: QuestionRepositoryOperationControl): Promise<QuestionIndexSyncResult> {
    const snapshot = admittedSnapshot(request?.snapshot);
    if (
      !snapshot ||
      !Array.isArray(request.sources) ||
      request.sources.length !== snapshot.manifest.length ||
      snapshot.manifest.length > limits.maxFiles ||
      (request.expectedGenerationId !== null && typeof request.expectedGenerationId !== 'string')
    )
      return failure('invalid', 'invalid-request');
    const sources = [...request.sources].map(source => ({ ...source, file: { ...source.file }, binding: { ...source.binding } }));
    if (
      sources.some(
        (source, i) =>
          source.file.path !== snapshot.manifest[i]?.path ||
          source.file.originalByteDigest !== snapshot.manifest[i]?.originalByteDigest ||
          source.snapshotId !== snapshot.snapshotId ||
          source.manifestDigest !== snapshot.manifestDigest ||
          JSON.stringify(source.binding) !== JSON.stringify(snapshot.binding) ||
          source.maxSourceBytes > limits.maxWorkerMemoryBytes / 4,
      )
    )
      return failure('invalid', 'invalid-request');
    const denied = await guard(snapshot, control);
    if (denied) return denied;
    if (writing) return failure('busy', 'busy');
    writing = true;
    const attempt = randomUUID();
    activeAttempt = attempt;
    const ledger = options.budget.snapshot();
    const diskBound = Math.max(0, limits.maxIndexDiskBytes - ledger.consumed.indexDiskBytes - ledger.reserved.indexDiskBytes);
    const chunkBound = Math.max(0, limits.maxChunks - ledger.consumed.indexedChunks - ledger.reserved.indexedChunks);
    const fileBound = Math.max(0, limits.maxFiles - ledger.consumed.indexedFiles - ledger.reserved.indexedFiles);
    const reservation = options.budget.reserveIndexBatch({
      batchSize: limits.maxBatchSize,
      cacheBytes: limits.maxSqliteCacheBytes,
      chunks: chunkBound,
      diskBytes: diskBound,
      files: fileBound,
      scannedBytes: snapshot.admissionLimits.maxBytes,
      scannedFiles: fileBound,
      vectorDimensions: options.embedding.profile.dimension,
      workerMemoryBytes: limits.maxWorkerMemoryBytes,
    });
    if (!reservation.ok) {
      writing = false;
      return failure(reservation.reasonCode === 'cancelled' ? 'cancelled' : 'exhausted', reservation.reasonCode === 'cancelled' ? 'cancelled' : 'scan-limit');
    }
    let work: QuestionBudgetWorkV1 = { indexedFiles: 0, indexedChunks: 0, indexDiskBytes: 0, scannedFiles: 0, scannedBytes: 0 };
    const tracked = trackIndexWork(fileBound, snapshot.admissionLimits.maxBytes, control.work);
    const execution = await reservation.value.execute(
      async context => {
        const bounded = {
          ...control,
          signal: AbortSignal.any([control.signal, context.signal]),
          deadlineEpochMs: Math.floor(Math.min(control.deadlineEpochMs, Date.now() + context.remainingMs, Date.now() + limits.maxIndexDeadlineMs)),
        };
        try {
          const current = await rpc({ kind: 'inspect', maxChunks: limits.maxChunks }, bounded);
          if (current.status !== 'ok') return current;
          if (!validView(current, options, !current.generation || compatible(current.generation, snapshot, options))) return unavailable();
          if ((current.generation?.generationId ?? null) !== request.expectedGenerationId) return failure('stale', 'binding-mismatch');
          const begin = await rpc({ kind: 'begin', attempt, leaseUntil: bounded.deadlineEpochMs, diskBytes: diskBound }, bounded);
          if (begin.status !== 'ok') return begin;
          const reuse = !!current.generation && compatible(current.generation, snapshot, options);
          const existing = new Map(reuse ? current.files.map(file => [file.path, file.originalByteDigest]) : []);
          const nextFiles = new Map(reuse ? current.files.map(file => [file.path, file]) : []);
          const desired = new Set(snapshot.manifest.map(file => file.path));
          for (const path of nextFiles.keys()) if (!desired.has(path)) nextFiles.delete(path);
          let writes = 0;
          let reused = 0;
          const changed = new Set(sources.filter(source => existing.get(source.file.path) !== source.file.originalByteDigest).map(source => source.file.path));
          for (const row of current.chunks) if (!changed.has(row.metadata.path) && desired.has(row.metadata.path) && reuse) reused++;
          for (const source of sources) {
            if (!changed.has(source.file.path)) continue;
            const before = await guard(snapshot, bounded);
            if (before) return before;
            if ((work.indexedFiles ?? 0) >= fileBound) return failure('exhausted', 'scan-limit');
            if (writes + reused >= limits.maxChunks || writes >= chunkBound || (work.scannedBytes ?? 0) + source.maxSourceBytes > snapshot.admissionLimits.maxBytes)
              return failure('exhausted', 'scan-limit');
            const built = await buildQuestionChunks({ ...source, maxChunks: Math.min(source.maxChunks, limits.maxChunks - writes - reused, chunkBound - writes) }, options.embedding, {
              ...bounded,
              work: tracked.meter,
            });
            if (built.file.omissionReasons.includes('budget-exhausted')) return failure(bounded.signal.aborted ? 'cancelled' : 'exhausted', bounded.signal.aborted ? 'cancelled' : 'scan-limit');
            if (built.file.omissionReasons.includes('stale-binding')) return failure('stale', 'binding-mismatch');
            nextFiles.set(source.file.path, built.file);
            const rows: QuestionIndexRow[] = [];
            for (const chunk of built.chunks) {
              const check = await guard(snapshot, bounded);
              if (check) return check;
              const vector = await options.embedding.embed(chunk.embeddingInput, bounded.signal);
              if (vector.status !== 'ok')
                return failure(
                  vector.status === 'cancelled' ? 'cancelled' : vector.status === 'overflow' ? 'exhausted' : 'unavailable',
                  vector.status === 'cancelled' ? 'cancelled' : vector.status === 'overflow' ? 'scan-limit' : 'store-unavailable',
                );
              rows.push({ metadata: chunk.metadata, embeddingInputTokens: vector.tokens, vector: vector.vector });
              if ((writes + reused + rows.length) * (options.embedding.profile.dimension * 8 + 2048) > limits.maxWorkerMemoryBytes / 2) return failure('exhausted', 'scan-limit');
            }
            if (!validView({ status: 'ok', generation: null, files: [built.file], chunks: rows, diskBytes: 0 }, options)) return failure('invalid', 'invalid-request');
            for (let offset = 0; offset < Math.max(1, rows.length); offset += limits.maxBatchSize) {
              const stage = await rpc({ kind: 'stage', attempt, file: built.file, rows: rows.slice(offset, offset + limits.maxBatchSize) }, bounded);
              if (stage.status !== 'ok') return stage;
              work = { ...work, indexDiskBytes: stage.diskBytes };
            }
            writes += rows.length;
            work = {
              ...work,
              indexedFiles: (work.indexedFiles ?? 0) + 1,
              indexedChunks: writes,
              scannedFiles: (work.scannedFiles ?? 0) + 1,
              scannedBytes: (work.scannedBytes ?? 0) + source.maxSourceBytes,
            };
          }
          const before = await guard(snapshot, bounded);
          if (before) return before;
          work = { ...work, scannedFiles: Math.max(work.scannedFiles ?? 0, tracked.consumed.scannedFiles), scannedBytes: Math.max(work.scannedBytes ?? 0, tracked.consumed.scannedBytes) };
          if (options.budget.snapshot().status !== 'open') return failure('cancelled', 'cancelled');
          const generation: QuestionIndexGenerationV1 = {
            schemaVersion: 'question-retrieval/1',
            generationId: `generation-${randomUUID()}`,
            binding: snapshot.binding,
            snapshotId: snapshot.snapshotId,
            manifestDigest: snapshot.manifestDigest,
            configDigest: options.configDigest,
            embeddingDigest: options.embeddingDigest,
            coverage: [...nextFiles.values()].every(file => file.coverage === 'complete') ? 'complete' : 'partial',
          };
          const published = await rpc(
            {
              kind: 'publish',
              attempt,
              expected: request.expectedGenerationId,
              generation,
              paths: [...desired],
              reuse: changed.size === 0 && reuse && current.generation?.manifestDigest === snapshot.manifestDigest,
            },
            bounded,
          );
          if (published.status !== 'ok') {
            admitted = undefined;
            return published;
          }
          work = { ...work, indexDiskBytes: published.diskBytes };
          admitted = generation.generationId;
          return { status: 'ok' as const, generation, vectorWrites: writes, reusedChunks: reused };
        } finally {
          if (!closed && worker)
            await rpc({ kind: 'cleanup', attempt, revoke: revoked }, { signal: new AbortController().signal, deadlineEpochMs: Math.min(control.deadlineEpochMs, Date.now() + 1000) });
        }
      },
      () => ({
        kind: 'work',
        work: { ...work, scannedFiles: Math.max(work.scannedFiles ?? 0, tracked.consumed.scannedFiles), scannedBytes: Math.max(work.scannedBytes ?? 0, tracked.consumed.scannedBytes) },
      }),
    );
    writing = false;
    activeAttempt = undefined;
    if (!execution.ok) {
      admitted = undefined;
      return failure(execution.reasonCode === 'cancelled' ? 'cancelled' : 'exhausted', execution.reasonCode === 'cancelled' ? 'cancelled' : 'deadline');
    }
    return execution.value;
  }
  return Object.freeze({
    synchronize,
    read,
    validateCurrent,
    async revoke() {
      if (closed) return;
      revoked = true;
      admitted = undefined;
      await rpc({ kind: 'cleanup', attempt: null, revoke: true }, { signal: new AbortController().signal, deadlineEpochMs: Date.now() + limits.maxIndexDeadlineMs });
    },
    async close() {
      closed = true;
      if (worker && activeAttempt) await rpc({ kind: 'cleanup', attempt: activeAttempt, revoke: false }, { signal: new AbortController().signal, deadlineEpochMs: Date.now() + 1000 });
      await stop();
    },
  });
}
