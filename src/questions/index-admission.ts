import { isAbsolute, resolve } from 'node:path';
/** Admission and persisted-row validation for the host-owned derived index. */
import type { QuestionIndexGenerationV1, SourceSnapshotV1 } from '../contracts/questions/contracts.ts';
import {
  validateQuestionIndexGeneration,
  validateQuestionIndexedChunk,
  validateQuestionIndexedFile,
  validateSourceSnapshot,
  validateRetrievalResourceLimits,
} from '../contracts/questions/validation.ts';
import { isProtectedPath } from '../contracts/foundation/uc03.ts';
import { computeFileDigest } from '../foundation/docker-workspace-policy.ts';
import { computeSourceManifestDigest } from '../foundation/question-repository-primitives.ts';
import type { IndexReply, QuestionIndexOptions } from './index-types.ts';
import type { QuestionRepositoryWork, QuestionRepositoryWorkMeter } from '../foundation/repository-types.ts';

/** Charges every guarded filesystem iteration before IO, including repeated reads and binding checks. */
export function trackIndexWork(
  maxFiles: number,
  maxBytes: number,
  upstream?: QuestionRepositoryWorkMeter,
): { readonly consumed: { scannedFiles: number; scannedBytes: number; returnedBytes: number }; readonly meter: QuestionRepositoryWorkMeter } {
  const consumed = { scannedFiles: 0, scannedBytes: 0, returnedBytes: 0 };
  const caps = { scannedFiles: maxFiles, scannedBytes: maxBytes, returnedBytes: maxBytes };
  return {
    consumed,
    meter: {
      remaining(key) {
        return Math.min(caps[key] - consumed[key], upstream?.remaining(key) ?? Number.MAX_SAFE_INTEGER);
      },
      charge(work: QuestionRepositoryWork) {
        const keys = ['scannedFiles', 'scannedBytes', 'returnedBytes'] as const;
        if (keys.some(key => !Number.isSafeInteger(work[key] ?? 0) || (work[key] ?? 0) < 0 || (work[key] ?? 0) > caps[key] - consumed[key])) return false;
        if (upstream && !upstream.charge(work)) return false;
        for (const key of keys) consumed[key] += work[key] ?? 0;
        return true;
      },
    },
  };
}

export function matches(generation: QuestionIndexGenerationV1, snapshot: SourceSnapshotV1, options: QuestionIndexOptions): boolean {
  return (
    generation.snapshotId === snapshot.snapshotId &&
    generation.manifestDigest === snapshot.manifestDigest &&
    compatible(generation, snapshot, options) &&
    generation.binding.revisionDigest === snapshot.binding.revisionDigest
  );
}
export function compatible(generation: QuestionIndexGenerationV1, snapshot: SourceSnapshotV1, options: QuestionIndexOptions): boolean {
  return (
    generation.binding.repositoryId === snapshot.binding.repositoryId &&
    generation.binding.workspaceId === snapshot.binding.workspaceId &&
    generation.binding.policyDigest === snapshot.binding.policyDigest &&
    generation.configDigest === options.configDigest &&
    generation.embeddingDigest === options.embeddingDigest
  );
}
export function admittedSnapshot(input: unknown): SourceSnapshotV1 | undefined {
  const checked = validateSourceSnapshot(input);
  if (!checked.ok || checked.value.manifestDigest !== computeSourceManifestDigest(checked.value.manifest)) return undefined;
  if (checked.value.manifest.some((file, index, all) => isProtectedPath(file.path) || file.path <= (all[index - 1]?.path ?? ''))) return undefined;
  return checked.value;
}
export function validView(result: Extract<IndexReply, { status: 'ok' }>, options: QuestionIndexOptions, requireProfile = true): boolean {
  if (result.generation && !validateQuestionIndexGeneration(result.generation).ok) return false;
  const files = new Map<string, string>();
  for (const file of result.files) {
    if (!validateQuestionIndexedFile(file).ok || files.has(file.path)) return false;
    files.set(file.path, file.originalByteDigest);
  }
  const ids = new Set<string>();
  for (const row of result.chunks) {
    if (
      !row ||
      !validateQuestionIndexedChunk(row.metadata).ok ||
      !Array.isArray(row.vector) ||
      ids.has(row.metadata.chunkId) ||
      files.get(row.metadata.path) !== row.metadata.originalByteDigest ||
      (requireProfile && row.metadata.vectorId !== computeFileDigest(JSON.stringify([row.metadata.chunkId, options.embedding.profile.id]))) ||
      !Number.isSafeInteger(row.embeddingInputTokens) ||
      row.embeddingInputTokens < 1 ||
      (requireProfile && row.embeddingInputTokens > options.embedding.profile.maxTokens) ||
      (requireProfile && row.vector.length !== options.embedding.profile.dimension) ||
      row.vector.length < 1 ||
      row.vector.length > 384 ||
      row.vector.some(value => !Number.isFinite(value)) ||
      Math.abs(row.vector.reduce((sum, value) => sum + value * value, 0) - 1) > 1e-5
    )
      return false;
    ids.add(row.metadata.chunkId);
  }
  const canonical = result.files.map(file => ({ path: file.path, originalByteDigest: file.originalByteDigest })).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return !result.generation || result.generation.manifestDigest === computeSourceManifestDigest(canonical);
}

export function indexOptions(input: QuestionIndexOptions): QuestionIndexOptions {
  const checked = validateRetrievalResourceLimits(input?.limits);
  if (
    !checked.ok ||
    !isAbsolute(input.databasePath) ||
    !input.targetRoots?.length ||
    input.targetRoots.some(root => !isAbsolute(root)) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.configDigest) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.embeddingDigest) ||
    typeof input.authorize !== 'function' ||
    typeof input.budget?.reserveIndexBatch !== 'function' ||
    typeof input.budget?.snapshot !== 'function' ||
    typeof input.embedding?.embed !== 'function' ||
    typeof input.embedding?.count !== 'function' ||
    !input.embedding.profile ||
    !Number.isSafeInteger(input.embedding.profile.dimension) ||
    input.embedding.profile.dimension < 1 ||
    input.embedding.profile.dimension > input.limits.maxVectorDimensions ||
    input.limits.maxWorkerMemoryBytes < 16 * 1024 * 1024 ||
    input.limits.maxIndexDiskBytes < 139264 ||
    input.limits.maxSqliteCacheBytes < 1024
  )
    throw new TypeError('Invalid host index configuration');
  const options: QuestionIndexOptions = Object.freeze({
    ...input,
    databasePath: resolve(input.databasePath),
    targetRoots: Object.freeze([...input.targetRoots]),
    limits: checked.value,
    embedding: Object.freeze({
      ...input.embedding,
      profile: Object.freeze({ ...input.embedding.profile }),
      count: input.embedding.count.bind(input.embedding),
      embed: input.embedding.embed.bind(input.embedding),
    }),
  });
  return options;
}
