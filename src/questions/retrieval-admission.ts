/** Copies host configuration and validates index provenance before any source-bearing retrieval result. */
import type { QuestionIdentityV1, QuestionIndexedFileV1, RepositoryBindingV1 } from '../contracts/questions/contracts.ts';
import {
  validateQuestionIdentity,
  validateQuestionIndexedChunk,
  validateQuestionIndexedFile,
  validateQuestionIndexGeneration,
  validateRetrievalResourceLimits,
  validateSourceSnapshot,
} from '../contracts/questions/validation.ts';
import { computeSourceManifestDigest } from '../foundation/question-repository-primitives.ts';
import { computeFileDigest } from '../foundation/docker-workspace-policy.ts';
import type { QuestionIndexReadResult, QuestionIndexView, QuestionIndexRow } from './index.ts';
import type { QuestionRetrievalOptions } from './retrieval-types.ts';

export function sameBinding(a: RepositoryBindingV1, b: RepositoryBindingV1): boolean {
  return a.repositoryId === b.repositoryId && a.workspaceId === b.workspaceId && a.policyDigest === b.policyDigest && a.revisionDigest === b.revisionDigest;
}
export function sameIdentity(a: QuestionIdentityV1, b: QuestionIdentityV1): boolean {
  return sameBinding(a.binding, b.binding) && a.sessionId === b.sessionId && a.taskId === b.taskId && a.runId === b.runId && a.questionId === b.questionId && a.configDigest === b.configDigest;
}
export function retrievalOptions(input: QuestionRetrievalOptions): QuestionRetrievalOptions {
  const identity = validateQuestionIdentity(input?.identity),
    snapshot = validateSourceSnapshot(input?.snapshot),
    limits = validateRetrievalResourceLimits(input?.limits);
  if (
    !identity.ok ||
    !snapshot.ok ||
    !limits.ok ||
    !sameBinding(identity.value.binding, snapshot.value.binding) ||
    snapshot.value.manifestDigest !== computeSourceManifestDigest(snapshot.value.manifest) ||
    !input.generationId ||
    !/^sha256:[a-f0-9]{64}$/.test(input.embeddingDigest) ||
    typeof input.index?.read !== 'function' ||
    typeof input.index?.validateCurrent !== 'function' ||
    typeof input.embedding?.embed !== 'function' ||
    typeof input.embedding?.count !== 'function' ||
    !input.embedding.profile ||
    typeof input.embedding.profile.id !== 'string' ||
    !input.embedding.profile.id ||
    !Number.isSafeInteger(input.embedding.profile.dimension) ||
    input.embedding.profile.dimension < 1 ||
    input.embedding.profile.dimension > limits.value.maxVectorDimensions ||
    !Number.isSafeInteger(input.embedding.profile.maxTokens) ||
    input.embedding.profile.maxTokens < 1 ||
    typeof input.budget?.reserveRetrievalQuery !== 'function' ||
    !input.repositoryLimits ||
    Object.values(input.repositoryLimits).some(value => !Number.isSafeInteger(value) || value < 1)
  )
    throw new TypeError('Invalid retrieval configuration');
  const manifest = snapshot.value.manifest;
  if (manifest.some((file, i) => file.path <= (manifest[i - 1]?.path ?? ''))) throw new TypeError('Invalid retrieval manifest');
  const scope = input.scope ? [...input.scope] : manifest.map(file => file.path);
  if (scope.length > limits.value.maxFiles || scope.some((path, i) => typeof path !== 'string' || !manifest.some(file => file.path === path) || path <= (scope[i - 1] ?? '')))
    throw new TypeError('Invalid host retrieval scope');
  return Object.freeze({
    ...input,
    identity: identity.value,
    snapshot: snapshot.value,
    limits: limits.value,
    scope: Object.freeze(scope),
    repositoryLimits: Object.freeze({ ...input.repositoryLimits }),
    embedding: Object.freeze({ profile: Object.freeze({ ...input.embedding.profile }), count: input.embedding.count.bind(input.embedding), embed: input.embedding.embed.bind(input.embedding) }),
    index: Object.freeze({ read: input.index.read.bind(input.index), validateCurrent: input.index.validateCurrent.bind(input.index) }),
    repository: Object.freeze({
      checkBinding: input.repository.checkBinding.bind(input.repository),
      readSpan: input.repository.readSpan.bind(input.repository),
      searchLiteral: input.repository.searchLiteral.bind(input.repository),
      listDirectory: input.repository.listDirectory.bind(input.repository),
    }),
  });
}
export function admittedView(result: QuestionIndexReadResult, options: QuestionRetrievalOptions): QuestionIndexView | undefined {
  if (result.status !== 'ok') return undefined;
  const generation = validateQuestionIndexGeneration(result.generation);
  if (
    !generation.ok ||
    !sameBinding(generation.value.binding, options.identity.binding) ||
    generation.value.snapshotId !== options.snapshot.snapshotId ||
    generation.value.manifestDigest !== options.snapshot.manifestDigest ||
    generation.value.configDigest !== options.identity.configDigest ||
    generation.value.embeddingDigest !== options.embeddingDigest ||
    generation.value.generationId !== options.generationId ||
    !Array.isArray(result.files) ||
    !Array.isArray(result.chunks)
  )
    return undefined;
  const files: QuestionIndexedFileV1[] = [];
  for (const file of result.files) {
    const checked = validateQuestionIndexedFile(file);
    if (!checked.ok) return undefined;
    files.push(checked.value);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (
    files.some((file, i) => file.path <= (files[i - 1]?.path ?? '')) ||
    computeSourceManifestDigest(files.map(file => ({ path: file.path, originalByteDigest: file.originalByteDigest }))) !== options.snapshot.manifestDigest
  )
    return undefined;
  const chunks: QuestionIndexRow[] = [];
  const identities = new Map<string, string>();
  for (const row of result.chunks) {
    const checked = validateQuestionIndexedChunk(row?.metadata);
    if (
      !checked.ok ||
      !files.some(file => file.path === checked.value.path && file.originalByteDigest === checked.value.originalByteDigest) ||
      !Array.isArray(row.vector) ||
      row.vector.length !== options.embedding.profile.dimension ||
      Array.from(row.vector).some(value => !Number.isFinite(value)) ||
      !Number.isSafeInteger(row.embeddingInputTokens) ||
      row.embeddingInputTokens < 1 ||
      row.embeddingInputTokens > options.embedding.profile.maxTokens
    )
      return undefined;
    if (checked.value.vectorId !== computeFileDigest(JSON.stringify([checked.value.chunkId, options.embedding.profile.id]))) return undefined;
    const norm = row.vector.reduce((sum: number, value: number) => sum + value * value, 0);
    if (Math.abs(norm - 1) > 1e-5) return undefined;
    const serialized = JSON.stringify([checked.value, row.embeddingInputTokens, row.vector]);
    const previous = identities.get(checked.value.chunkId);
    if (previous !== undefined && previous !== serialized) return undefined;
    identities.set(checked.value.chunkId, serialized);
    chunks.push(Object.freeze({ metadata: checked.value, embeddingInputTokens: row.embeddingInputTokens, vector: Object.freeze([...row.vector]) }));
  }
  return Object.freeze({ generation: generation.value, files: Object.freeze(files), chunks: Object.freeze(chunks) });
}
