/** Incremental refresh and authorized publication reconciliation under one finite host reservation. */
import { randomUUID } from 'node:crypto';
import type { QuestionIndexGenerationV1, SourceSnapshotV1 } from '../contracts/questions/contracts.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import { buildQuestionChunks } from './chunks.ts';
import { admittedSnapshot, compatible, trackIndexWork, validView } from './index-admission.ts';
import { waitForIndexControl } from './index-client.ts';
import { publicationMatches, validOperationId } from './index-recovery.ts';
import type { QuestionBudgetWorkV1 } from './budget.ts';
import type { IndexCommand, IndexReply, QuestionIndex, QuestionIndexFailure, QuestionIndexOptions, QuestionIndexRow, QuestionIndexSyncResult } from './index-types.ts';
const failure = (status: QuestionIndexFailure['status'], reasonCode: QuestionIndexFailure['reasonCode']): QuestionIndexFailure => ({ status, reasonCode });
const unavailable = () => failure('unavailable', 'store-unavailable');
interface RefreshLifecycle {
  readonly guard: (snapshot: SourceSnapshotV1, control: QuestionRepositoryOperationControl) => Promise<QuestionIndexFailure | undefined>;
  readonly rpc: (command: IndexCommand, control: QuestionRepositoryOperationControl) => Promise<IndexReply>;
  readonly stop: () => Promise<number>;
  readonly closed: () => boolean;
  readonly revoked: () => boolean;
  readonly running: () => boolean;
  readonly admit: (generationId: string | undefined) => void;
}
/** Credit only disk settled by this ledger for the generation named by a durable receipt. */
const settledDisk = new WeakMap<QuestionIndexOptions['budget'], Map<string, number>>();

export function createIndexRefresh(
  options: QuestionIndexOptions,
  lifecycle: RefreshLifecycle,
): { readonly synchronize: QuestionIndex['synchronize']; readonly activeAttempt: () => string | undefined } {
  const limits = options.limits;
  const { guard, rpc, stop } = lifecycle;
  const diskChargeKey = (generationId: string) => JSON.stringify([options.databasePath, generationId]);
  let writing = false;
  let activeAttempt: string | undefined;
  async function synchronize(request: Parameters<QuestionIndex['synchronize']>[0], control: QuestionRepositoryOperationControl): Promise<QuestionIndexSyncResult> {
    const expectedGenerationId = request?.expectedGenerationId;
    const operationId = request?.operationId ?? randomUUID();
    const snapshot = admittedSnapshot(request?.snapshot);
    if (
      !snapshot ||
      !Array.isArray(request.sources) ||
      request.sources.length !== snapshot.manifest.length ||
      snapshot.manifest.length > limits.maxFiles ||
      !validOperationId(operationId) ||
      (expectedGenerationId !== null && typeof expectedGenerationId !== 'string')
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
    const scannedBytes = fileBound === 0 ? 0 : snapshot.admissionLimits.maxBytes;
    const reservation = options.budget.reserveIndexBatch(
      {
        batchSize: limits.maxBatchSize,
        cacheBytes: limits.maxSqliteCacheBytes,
        chunks: fileBound === 0 ? 0 : chunkBound,
        diskBytes: diskBound,
        files: fileBound,
        scannedBytes,
        scannedFiles: fileBound,
        vectorDimensions: options.embedding.profile.dimension,
        workerMemoryBytes: limits.maxWorkerMemoryBytes,
      },
      true,
    );
    if (!reservation.ok) {
      writing = false;
      activeAttempt = undefined;
      return failure(reservation.reasonCode === 'cancelled' ? 'cancelled' : 'exhausted', reservation.reasonCode === 'cancelled' ? 'cancelled' : 'scan-limit');
    }
    let work: QuestionBudgetWorkV1 = { indexedFiles: 0, indexedChunks: 0, indexDiskBytes: 0, scannedFiles: 0, scannedBytes: 0 };
    const maximum = reservation.value.maximumWork;
    const tracked = trackIndexWork(maximum.scannedFiles ?? 0, maximum.scannedBytes ?? 0, control.work);
    let chargedGeneration: string | undefined;
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
          const replay = publicationMatches(current, operationId, expectedGenerationId, snapshot, options);
          if (replay === 'invalid') return unavailable();
          if (replay === 'mismatch') return failure('stale', 'binding-mismatch');
          if (replay === 'match' && current.generation) {
            const after = await guard(snapshot, bounded);
            if (after) return after;
            if (options.budget.snapshot().status !== 'open') return failure('cancelled', 'cancelled');
            const confirmed = await rpc({ kind: 'current' }, bounded);
            if (confirmed.status !== 'ok') return confirmed;
            if (
              lifecycle.closed() ||
              lifecycle.revoked() ||
              confirmed.generation?.generationId !== current.generation.generationId ||
              publicationMatches(confirmed, operationId, expectedGenerationId, snapshot, options) !== 'match'
            )
              return failure('stale', 'binding-mismatch');
            chargedGeneration = current.generation.generationId;
            const alreadyCharged = settledDisk.get(options.budget)?.get(diskChargeKey(chargedGeneration)) ?? 0;
            const additionalDisk = Math.max(0, confirmed.diskBytes - alreadyCharged);
            if (additionalDisk > diskBound) return failure('exhausted', 'scan-limit');
            work = { ...work, indexDiskBytes: additionalDisk };
            lifecycle.admit(chargedGeneration);
            return { status: 'ok' as const, generation: current.generation, vectorWrites: 0, reusedChunks: current.chunks.length };
          }
          if ((current.generation?.generationId ?? null) !== expectedGenerationId) return failure('stale', 'binding-mismatch');
          if (!maximum.indexedFiles) return failure('exhausted', 'scan-limit');
          const begin = await rpc({ kind: 'begin', attempt, leaseUntil: bounded.deadlineEpochMs, diskBytes: diskBound }, bounded);
          if (begin.status !== 'ok') return begin;
          const reuse = !!current.generation && compatible(current.generation, snapshot, options);
          const existing = new Map(reuse ? current.files.filter(file => file.coverage === 'complete').map(file => [file.path, file.originalByteDigest]) : []);
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
              const vector = await waitForIndexControl(options.embedding.embed(chunk.embeddingInput, bounded.signal), bounded);
              if ('reasonCode' in vector) return vector;
              if (bounded.signal.aborted) return failure('cancelled', 'cancelled');
              if (Date.now() >= bounded.deadlineEpochMs) return failure('exhausted', 'deadline');
              if (vector.status !== 'ok')
                return failure(
                  vector.status === 'cancelled' ? 'cancelled' : vector.status === 'overflow' ? 'exhausted' : 'unavailable',
                  vector.status === 'cancelled' ? 'cancelled' : vector.status === 'overflow' ? 'scan-limit' : 'store-unavailable',
                );
              if (!Array.isArray(vector.vector) || vector.vector.length !== options.embedding.profile.dimension) return failure('invalid', 'invalid-request');
              rows.push({ metadata: chunk.metadata, embeddingInputTokens: vector.tokens, vector: [...vector.vector] });
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
          // A lost commit reply leaves disk growth uncertain. Charge the reserved bound
          // unless an authorized result/reopen establishes the observed allocation.
          const stagedDiskBytes = work.indexDiskBytes ?? 0;
          work = { ...work, indexDiskBytes: diskBound };
          chargedGeneration = generation.generationId;
          const published = await rpc(
            {
              kind: 'publish',
              attempt,
              operationId,
              expected: expectedGenerationId,
              generation,
              paths: [...desired],
              reuse: changed.size === 0 && reuse && current.generation?.manifestDigest === snapshot.manifestDigest,
            },
            bounded,
          );
          if (published.status !== 'ok') {
            if (published.status === 'unavailable' || published.status === 'cancelled' || (published.status === 'exhausted' && published.reasonCode === 'deadline')) lifecycle.admit(undefined);
            else work = { ...work, indexDiskBytes: stagedDiskBytes };
            if (published.status === 'unavailable') {
              await stop();
              const authorized = await guard(snapshot, bounded);
              if (authorized) return authorized;
              if (options.budget.snapshot().status !== 'open') return failure('cancelled', 'cancelled');
              const reopened = await rpc({ kind: 'inspect', maxChunks: limits.maxChunks }, bounded);
              if (reopened.status !== 'ok') return reopened;
              if (!validView(reopened, options)) return unavailable();
              if (publicationMatches(reopened, operationId, expectedGenerationId, snapshot, options) === 'match' && reopened.generation) {
                const after = await guard(snapshot, bounded);
                if (after) return after;
                const confirmed = await rpc({ kind: 'current' }, bounded);
                if (confirmed.status !== 'ok') return confirmed;
                if (
                  lifecycle.closed() ||
                  lifecycle.revoked() ||
                  options.budget.snapshot().status !== 'open' ||
                  confirmed.generation?.generationId !== reopened.generation.generationId ||
                  publicationMatches(confirmed, operationId, expectedGenerationId, snapshot, options) !== 'match'
                )
                  return failure('stale', 'binding-mismatch');
                lifecycle.admit(reopened.generation.generationId);
                work = { ...work, indexDiskBytes: reopened.diskBytes };
                return { status: 'ok' as const, generation: reopened.generation, vectorWrites: writes, reusedChunks: reused };
              }
            }
            return published;
          }
          work = { ...work, indexDiskBytes: published.diskBytes };
          const after = await guard(snapshot, bounded);
          if (after) return after;
          const confirmed = await rpc({ kind: 'current' }, bounded);
          if (confirmed.status !== 'ok') return confirmed;
          if (
            lifecycle.closed() ||
            lifecycle.revoked() ||
            options.budget.snapshot().status !== 'open' ||
            confirmed.generation?.generationId !== generation.generationId ||
            publicationMatches(confirmed, operationId, expectedGenerationId, snapshot, options) !== 'match'
          )
            return failure('stale', 'binding-mismatch');
          lifecycle.admit(generation.generationId);
          return { status: 'ok' as const, generation, vectorWrites: writes, reusedChunks: reused };
        } finally {
          if (!lifecycle.closed() && lifecycle.running())
            await rpc({ kind: 'cleanup', attempt, revoke: false }, { signal: new AbortController().signal, deadlineEpochMs: Math.min(control.deadlineEpochMs, Date.now() + 1000) });
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
      lifecycle.admit(undefined);
      return failure(execution.reasonCode === 'cancelled' ? 'cancelled' : 'exhausted', execution.reasonCode === 'cancelled' ? 'cancelled' : 'deadline');
    }
    if (chargedGeneration && work.indexDiskBytes) {
      const charged = settledDisk.get(options.budget) ?? new Map<string, number>();
      const key = diskChargeKey(chargedGeneration);
      charged.set(key, (charged.get(key) ?? 0) + work.indexDiskBytes);
      settledDisk.set(options.budget, charged);
    }
    return execution.value;
  }
  return { synchronize, activeAttempt: () => activeAttempt };
}
