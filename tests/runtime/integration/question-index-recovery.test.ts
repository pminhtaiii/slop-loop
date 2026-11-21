import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { SourceSnapshotV1, SpanResultV1 } from '../../../src/contracts/questions/contracts.ts';
import { computeFileDigest } from '../../../src/foundation/docker-workspace-policy.ts';
import { computeSourceManifestDigest } from '../../../src/foundation/question-repository-primitives.ts';
import { createQuestionBudgetLedger } from '../../../src/questions/budget.ts';
import { createControlledQuestionEmbedding } from '../../../src/questions/embedding.ts';
import { createQuestionIndex } from '../../../src/questions/index.ts';

const digest = computeFileDigest;
const limits = {
  maxFiles: 20,
  maxChunks: 200,
  maxVectorDimensions: 2,
  maxBatchSize: 8,
  maxConcurrentIndexWriters: 1,
  maxConcurrentRetrievalWorkers: 1,
  maxIndexDiskBytes: 16_000_000,
  maxSqliteCacheBytes: 64_000,
  maxWorkerMemoryBytes: 64_000_000,
  maxExactScanVectors: 200,
  maxIndexDeadlineMs: 20_000,
  maxRetrievalDeadlineMs: 10_000,
};
const control = () => ({ signal: new AbortController().signal, deadlineEpochMs: Date.now() + 20_000 });

function budget(retrieval = limits, maxScannedBytes = 10_000_000) {
  const result = createQuestionBudgetLedger(
    {
      schemaVersion: 'question-budget/1',
      runtime: {
        maxToolCalls: 200,
        maxModelCalls: 10,
        maxScannedFiles: 1000,
        maxScannedBytes,
        maxReturnedBytes: 1_000_000,
        maxInputTokensPerCall: 2000,
        maxOutputTokensPerCall: 500,
        maxBillableTokensTask: 100_000,
        maxCostMicrosTask: 1_000_000,
        maxElapsedMsTask: 120_000,
        maxClarificationRounds: 2,
        maxConversationBytes: 10_000,
        maxFinalBytes: 4000,
      },
      repository: { maxFileBytes: 20_000, maxSpanBytes: 4096, maxSpanLines: 60, maxPageEntries: 100, maxSearchHits: 20, maxQueryBytes: 1000, maxPathBytes: 500 },
      retrieval,
    },
    { pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 } },
  );
  assert.ok(result.ok);
  return result.value;
}
function source(files: Record<string, string>, snapshotId = 'snapshot', revision = snapshotId) {
  const binding = { repositoryId: 'repo', workspaceId: 'workspace', revisionDigest: digest(revision), policyDigest: digest('policy') };
  const manifest = Object.entries(files)
    .map(([path, text]) => ({ path, originalByteDigest: digest(text) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const snapshot: SourceSnapshotV1 = {
    snapshotId,
    binding,
    manifestDigest: computeSourceManifestDigest(manifest),
    acquisitionId: 'acquired',
    admissionLimits: { maxFiles: 20, maxBytes: 100_000, maxElapsedMs: 20_000 },
    manifest,
  };
  const sources = manifest.map(file => {
    const text = files[file.path];
    assert.equal(typeof text, 'string');
    const lines = (text ?? '').split('\n');
    return {
      file: { ...file, fileType: 'python-source' as const, lineCount: lines.length },
      binding,
      snapshotId,
      manifestDigest: snapshot.manifestDigest,
      pageLines: 60,
      maxSourceBytes: 20_000,
      maxChunks: 200,
      repository: {
        async checkBinding() {
          return { status: 'ok' as const, binding };
        },
        async readSpan({ path, startLine, endLine }: { path: string; startLine: number; endLine: number }): Promise<SpanResultV1> {
          if (startLine > lines.length) return { status: 'invalid', reasonCode: 'out-of-range' };
          const excerpt = lines.slice(startLine - 1, endLine).join('\n');
          return {
            status: 'ok',
            span: {
              path,
              range: { startLine, endLine: Math.min(endLine, lines.length) },
              excerpt,
              excerptDigest: digest(excerpt),
              originalByteDigest: file.originalByteDigest,
              evidenceId: 'evidence',
              snapshotId,
              manifestDigest: snapshot.manifestDigest,
              truncation: { kind: 'none' },
              identity: { binding, sessionId: 'session', taskId: 'task', runId: 'run', questionId: 'question', configDigest: digest('config') },
            },
          };
        },
      },
    };
  });
  return { snapshot, sources };
}

test('a target child with leading dots cannot host the database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'question-dot-index-'));
  const target = join(directory, 'target');
  await mkdir(target);
  const databasePath = join(target, '..cache.sqlite');
  let embedded = 0;
  const index = createQuestionIndex({
    databasePath,
    targetRoots: [target],
    limits,
    budget: budget(),
    configDigest: digest('config'),
    embeddingDigest: digest('embedding'),
    authorize: async () => true,
    embedding: createControlledQuestionEmbedding(
      { id: 'controlled/1', dimension: 2, maxTokens: 512 },
      () => [1],
      () => {
        embedded++;
        return [1, 0];
      },
    ),
  });
  try {
    const result = await index.synchronize({ ...source({ 'a.py': 'def first():\n    pass' }), expectedGenerationId: null }, control());
    assert.equal(result.status, 'unavailable');
    assert.equal(embedded, 0);
    assert.equal(existsSync(databasePath), false);
  } finally {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function configuration(directory: string, overrides: Partial<Parameters<typeof createQuestionIndex>[0]> = {}) {
  return {
    databasePath: join(directory, 'index.sqlite'),
    targetRoots: [join(directory, 'target')],
    limits,
    budget: budget(),
    configDigest: digest('config'),
    embeddingDigest: digest('embedding'),
    authorize: async () => true,
    embedding: createControlledQuestionEmbedding(
      { id: 'controlled/1', dimension: 2, maxTokens: 512 },
      () => [1],
      () => [1, 0],
    ),
    ...overrides,
  };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'question-recovery-'));
  await mkdir(join(directory, 'target'));
  return directory;
}
async function bounded<T>(pending: Promise<T>, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('test wait deadline')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('cancellation ends an uncooperative authority wait promptly without effects', async () => {
  const directory = await fixture();
  const index = createQuestionIndex(configuration(directory, { authorize: () => new Promise(() => undefined) }));
  const cancel = new AbortController();
  try {
    const pending = index.synchronize({ ...source({ 'a.py': 'def first():\n    pass' }), expectedGenerationId: null }, { signal: cancel.signal, deadlineEpochMs: Date.now() + 10_000 });
    cancel.abort();
    assert.equal((await bounded(pending)).status, 'cancelled');
    assert.equal(existsSync(join(directory, 'index.sqlite')), false);
  } finally {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('refresh keeps its predecessor captured before asynchronous authority approval', async () => {
  const directory = await fixture();
  let release: (() => void) | undefined;
  let firstGuard = true;
  const index = createQuestionIndex(
    configuration(directory, {
      authorize: () => {
        if (!firstGuard) return Promise.resolve(true);
        firstGuard = false;
        return new Promise(resolve => {
          release = () => resolve(true);
        });
      },
    }),
  );
  const request = { ...source({}), expectedGenerationId: null as string | null };
  try {
    const pending = index.synchronize(request, control());
    request.expectedGenerationId = 'forged-after-dispatch';
    release?.();
    assert.equal((await bounded(pending)).status, 'ok');
  } finally {
    release?.();
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unchanged source with transient unavailable coverage is retried', async () => {
  const directory = await fixture();
  const index = createQuestionIndex(configuration(directory));
  const initial = source({ 'a.py': 'def recovered():\n    pass' });
  const fileSource = initial.sources[0];
  assert.ok(fileSource);
  const original = fileSource.repository.readSpan;
  let unavailable = true;
  fileSource.repository.readSpan = async request => (unavailable ? { status: 'unavailable', reasonCode: 'unsupported-adapter' } : original(request));
  try {
    const first = await index.synchronize({ ...initial, expectedGenerationId: null }, control());
    assert.equal(first.status, 'ok');
    if (first.status !== 'ok') return;
    assert.equal(first.generation.coverage, 'partial');
    unavailable = false;
    const retry = await index.synchronize({ ...initial, expectedGenerationId: first.generation.generationId }, control());
    assert.equal(retry.status, 'ok');
    if (retry.status !== 'ok') return;
    assert.equal(retry.generation.coverage, 'complete');
    assert.equal(retry.vectorWrites, 1);
  } finally {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('operation identity reconciles a committed refresh after reopen without duplicate embeddings', async () => {
  const directory = await fixture();
  let embedded = 0;
  let authorized = true;
  const oneFile = { ...limits, maxFiles: 1 };
  const options = configuration(directory, {
    limits: oneFile,
    budget: budget(oneFile),
    authorize: async () => authorized,
    embedding: createControlledQuestionEmbedding(
      { id: 'controlled/1', dimension: 2, maxTokens: 512 },
      () => [1],
      () => {
        embedded++;
        return [1, 0];
      },
    ),
  });
  let index = createQuestionIndex(options);
  const initial = source({ 'a.py': 'def first():\n    pass' });
  const request = { ...initial, expectedGenerationId: null, operationId: 'stable-operation' };
  try {
    const saved = await index.synchronize(request, control());
    assert.equal(saved.status, 'ok');
    if (saved.status !== 'ok') return;
    const charged = options.budget.snapshot().consumed.indexDiskBytes;
    assert.ok(charged > 0);
    await index.close();
    index = createQuestionIndex(options);
    const sameLedger = await index.synchronize(request, control());
    assert.equal(sameLedger.status, 'ok');
    assert.equal(options.budget.snapshot().consumed.indexDiskBytes, charged);
    await index.close();
    const freshBudget = budget(oneFile);
    index = createQuestionIndex({ ...options, budget: freshBudget });
    const recovered = await index.synchronize(request, control());
    assert.equal(recovered.status, 'ok');
    if (recovered.status !== 'ok') return;
    assert.equal(recovered.generation.generationId, saved.generation.generationId);
    assert.equal(recovered.vectorWrites, 0);
    assert.equal(freshBudget.snapshot().consumed.indexDiskBytes, charged);
    assert.equal(embedded, 1);
    assert.equal((await index.read({ snapshot: initial.snapshot, generationId: recovered.generation.generationId, maxChunks: 200 }, control())).status, 'ok');
    assert.equal((await index.synchronize({ ...request, operationId: 'foreign-operation' }, control())).status, 'stale');
    assert.equal((await index.synchronize({ ...request, expectedGenerationId: saved.generation.generationId }, control())).status, 'stale');
    authorized = false;
    assert.equal((await index.synchronize(request, control())).status, 'stale');
    authorized = true;
    const next = source({ 'a.py': 'def second():\n    pass' }, 'next');
    const newer = await index.synchronize({ ...next, expectedGenerationId: saved.generation.generationId, operationId: 'newer-operation' }, control());
    assert.equal(newer.status, 'ok');
    assert.equal((await index.synchronize(request, control())).status, 'stale');
  } finally {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('explicit revoke waits through a transient writer lock and disables serving immediately', async () => {
  const directory = await fixture();
  const options = configuration(directory);
  const index = createQuestionIndex(options);
  let locked: DatabaseSync | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const initial = source({ 'a.py': 'def first():\n    pass' });
    const saved = await index.synchronize({ ...initial, expectedGenerationId: null }, control());
    assert.equal(saved.status, 'ok');
    if (saved.status !== 'ok') return;
    locked = new DatabaseSync(options.databasePath);
    locked.exec('BEGIN IMMEDIATE');
    const pending = index.revoke();
    assert.equal((await index.read({ snapshot: initial.snapshot, generationId: saved.generation.generationId, maxChunks: 200 }, control())).status, 'unavailable');
    timer = setTimeout(() => {
      locked?.exec('ROLLBACK');
    }, 75);
    await bounded(pending);
    await index.close();
    const reopened = createQuestionIndex({ ...options, budget: budget() });
    try {
      assert.equal((await reopened.synchronize({ ...initial, expectedGenerationId: null }, control())).status, 'ok');
    } finally {
      await reopened.close();
    }
  } finally {
    clearTimeout(timer);
    if (locked?.isTransaction) locked.exec('ROLLBACK');
    locked?.close();
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('explicit revoke exposes unconfirmed cleanup when a writer remains locked beyond its bound', async () => {
  const directory = await fixture();
  const options = configuration(directory, { limits: { ...limits, maxIndexDeadlineMs: 500 } });
  const index = createQuestionIndex(options);
  let locked: DatabaseSync | undefined;
  try {
    const saved = await index.synchronize({ ...source({}), expectedGenerationId: null }, control());
    assert.equal(saved.status, 'ok');
    locked = new DatabaseSync(options.databasePath);
    locked.exec('BEGIN IMMEDIATE');
    await assert.rejects(bounded(index.revoke(), 1500), /cleanup.*unconfirmed/i);
  } finally {
    if (locked?.isTransaction) locked.exec('ROLLBACK');
    locked?.close();
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('malformed embedding profiles and noncallable ports fail before binding', async () => {
  const directory = await fixture();
  const options = configuration(directory);
  try {
    for (const embedding of [
      { ...options.embedding, profile: undefined },
      { ...options.embedding, profile: { ...options.embedding.profile, id: undefined } },
      { ...options.embedding, profile: { ...options.embedding.profile, id: ' ' } },
      { ...options.embedding, profile: { ...options.embedding.profile, maxTokens: undefined } },
      { ...options.embedding, profile: { ...options.embedding.profile, maxTokens: 1.5 } },
      { ...options.embedding, profile: { ...options.embedding.profile, dimension: NaN } },
      { ...options.embedding, profile: { ...options.embedding.profile, dimension: 0 } },
      { ...options.embedding, count: true },
      { ...options.embedding, embed: true },
    ]) {
      assert.throws(() => createQuestionIndex({ ...options, embedding: embedding as unknown as typeof options.embedding }), /Invalid host index configuration/);
    }
    assert.equal(existsSync(options.databasePath), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const operation of ['validateCurrent', 'read'] as const)
  test(`a durable head changed during final authority approval cannot ${operation} the predecessor`, async () => {
    const directory = await fixture();
    let pause = false;
    let calls = 0;
    let enter: (() => void) | undefined;
    let release: (() => void) | undefined;
    const entered = new Promise<void>(resolve => {
      enter = resolve;
    });
    const options = configuration(directory, {
      authorize: async () => {
        if (pause && ++calls === 2) {
          enter?.();
          await new Promise<void>(resolve => {
            release = resolve;
          });
        }
        return true;
      },
    });
    const index = createQuestionIndex(options);
    const rival = createQuestionIndex({ ...options, budget: budget(), authorize: async () => true });
    try {
      const initial = source({ 'a.py': 'def first():\n    pass' });
      const saved = await index.synchronize({ ...initial, expectedGenerationId: null }, control());
      assert.equal(saved.status, 'ok');
      if (saved.status !== 'ok') return;
      pause = true;
      const reference = { snapshot: initial.snapshot, generationId: saved.generation.generationId, maxChunks: 200 };
      const checking = index[operation](reference, control());
      await bounded(
        Promise.race([
          entered,
          checking.then(() => {
            throw new Error('validation completed before authority gate');
          }),
        ]),
      );
      const next = source({ 'a.py': 'def newer():\n    pass' }, 'next');
      assert.equal((await rival.synchronize({ ...next, expectedGenerationId: saved.generation.generationId }, control())).status, 'ok');
      release?.();
      assert.equal((await bounded(checking)).status, 'stale');
    } finally {
      release?.();
      await Promise.all([index.close(), rival.close()]);
      await rm(directory, { recursive: true, force: true });
    }
  });

test('final serialized generation memory quota refusal keeps the complete predecessor', async () => {
  const directory = await fixture();
  const largeLimits = { ...limits, maxVectorDimensions: 384, maxChunks: 2000, maxExactScanVectors: 2000, maxWorkerMemoryBytes: 16_777_216 };
  const vector = Array.from({ length: 384 }, () => 1 / Math.sqrt(384));
  const options = configuration(directory, {
    limits: largeLimits,
    budget: budget(largeLimits),
    embedding: createControlledQuestionEmbedding(
      { id: 'large/1', dimension: 384, maxTokens: 512 },
      () => [1],
      () => vector,
    ),
  });
  const index = createQuestionIndex(options);
  try {
    const initial = source({ 'old.py': 'def predecessor():\n    pass' });
    const saved = await index.synchronize({ ...initial, expectedGenerationId: null }, control());
    assert.equal(saved.status, 'ok');
    if (saved.status !== 'ok') return;
    const files = Object.fromEntries(Array.from({ length: 10 }, (_, file) => [String(file) + '.py', Array.from({ length: 40 }, (_, i) => 'def function_' + i + '():\n    return ' + i).join('\n')]));
    const nextSource = source(files, 'large');
    const next = { ...nextSource, snapshot: { ...nextSource.snapshot, admissionLimits: { ...nextSource.snapshot.admissionLimits, maxBytes: 1_000_000 } } };
    const refused = await index.synchronize({ ...next, expectedGenerationId: saved.generation.generationId }, control());
    assert.deepEqual(refused, { status: 'exhausted', reasonCode: 'scan-limit' });
    assert.equal((await index.validateCurrent({ snapshot: initial.snapshot, generationId: saved.generation.generationId }, control())).status, 'ok');
    const read = await index.read({ snapshot: initial.snapshot, generationId: saved.generation.generationId, maxChunks: 2000 }, control());
    assert.equal(read.status, 'ok');
    if (read.status === 'ok')
      assert.deepEqual(
        read.chunks.map(row => row.metadata.symbolName),
        ['predecessor'],
      );
  } finally {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('revocation reclaims an oversized index that refuses ordinary reads', async () => {
  const directory = await fixture();
  const small = { ...limits, maxIndexDiskBytes: 200_000 };
  const options = configuration(directory, { limits: small, budget: budget(small) });
  const index = createQuestionIndex(options);
  try {
    const initial = source({ 'a.py': 'def first():\n    pass' });
    const saved = await index.synchronize({ ...initial, expectedGenerationId: null }, control());
    assert.equal(saved.status, 'ok');
    if (saved.status !== 'ok') return;
    const database = new DatabaseSync(options.databasePath);
    try {
      database.exec('CREATE TABLE fixture_padding (data BLOB); INSERT INTO fixture_padding VALUES(zeroblob(400000)); DROP TABLE fixture_padding');
    } finally {
      database.close();
    }
    assert.ok((await stat(options.databasePath)).size > small.maxIndexDiskBytes);
    assert.equal((await index.read({ snapshot: initial.snapshot, generationId: saved.generation.generationId, maxChunks: 200 }, control())).status, 'exhausted');
    await index.revoke();
    assert.ok((await stat(options.databasePath)).size < small.maxIndexDiskBytes);
    const reopened = createQuestionIndex({ ...options, budget: budget(small) });
    try {
      assert.equal((await reopened.synchronize({ ...initial, expectedGenerationId: null }, control())).status, 'ok');
    } finally {
      await reopened.close();
    }
  } finally {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancelled embedding settles promptly and cannot stage into a retry', async () => {
  const directory = await fixture();
  const options = configuration(directory);
  const embeddingStarted = Promise.withResolvers<undefined>();
  const late = Promise.withResolvers<{ status: 'ok'; tokens: number; vector: number[] }>();
  let calls = 0;
  const index = createQuestionIndex({
    ...options,
    embedding: {
      ...options.embedding,
      async embed() {
        if (++calls !== 1) return { status: 'ok', tokens: 1, vector: [1, 0] };
        embeddingStarted.resolve(undefined);
        return late.promise;
      },
    },
  });
  const abort = new AbortController();
  try {
    const request = { ...source({ 'a.py': 'def first():\n    pass' }), expectedGenerationId: null };
    const pending = index.synchronize(request, { ...control(), signal: abort.signal });
    await bounded(embeddingStarted.promise);
    abort.abort();
    assert.equal((await bounded(pending)).status, 'cancelled');
    const retry = index.synchronize(request, control());
    late.resolve({ status: 'ok', tokens: 1, vector: [0, 1] });
    const saved = await bounded(retry);
    assert.equal(saved.status, 'ok');
    if (saved.status !== 'ok') return;
    const read = await index.read({ snapshot: request.snapshot, generationId: saved.generation.generationId, maxChunks: 200 }, control());
    assert.equal(read.status, 'ok');
    if (read.status === 'ok')
      assert.deepEqual(
        read.chunks.map(row => row.vector),
        [[1, 0]],
      );
  } finally {
    abort.abort();
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('replay refuses a replacement head with the same operation identity', async () => {
  const directory = await fixture();
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let calls = 0;
  let replaying = false;
  const first = configuration(directory, {
    async authorize() {
      if (replaying && ++calls === 2) {
        entered.resolve(undefined);
        await release.promise;
      }
      return true;
    },
  });
  const index = createQuestionIndex(first);
  const revoker = createQuestionIndex(configuration(directory));
  const replacement = createQuestionIndex(configuration(directory));
  const request = { ...source({ 'a.py': 'def first():\n    pass' }), expectedGenerationId: null, operationId: 'repeated-operation' };
  try {
    const saved = await index.synchronize(request, control());
    assert.equal(saved.status, 'ok');
    if (saved.status !== 'ok') return;
    const charged = first.budget.snapshot().consumed.indexDiskBytes;
    replaying = true;
    const pending = index.synchronize(request, control());
    await bounded(entered.promise);
    await revoker.revoke();
    const newer = await replacement.synchronize(request, control());
    assert.equal(newer.status, 'ok');
    if (newer.status !== 'ok') return;
    assert.notEqual(newer.generation.generationId, saved.generation.generationId);
    release.resolve(undefined);
    assert.equal((await bounded(pending)).status, 'stale');
    assert.equal(first.budget.snapshot().consumed.indexDiskBytes, charged);
  } finally {
    release.resolve(undefined);
    await Promise.all([index.close(), revoker.close(), replacement.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('replay does not require a second source scan reservation', async () => {
  const directory = await fixture();
  const ledger = budget(limits, 100_000);
  const index = createQuestionIndex(configuration(directory, { budget: ledger }));
  const request = { ...source({ 'a.py': 'def first():\n    pass' }), expectedGenerationId: null, operationId: 'without-rescan' };
  try {
    const saved = await index.synchronize(request, control());
    assert.equal(saved.status, 'ok');
    const consumed = ledger.snapshot().consumed;
    assert.ok(consumed.scannedBytes > 0);
    const replay = await index.synchronize(request, control());
    assert.equal(replay.status, 'ok');
    assert.equal(ledger.snapshot().consumed.scannedBytes, consumed.scannedBytes);
    assert.equal(ledger.snapshot().consumed.indexDiskBytes, consumed.indexDiskBytes);
    if (saved.status !== 'ok') return;
    const next = { ...source({ 'a.py': 'def second():\n    pass' }, 'other'), expectedGenerationId: saved.generation.generationId };
    assert.equal((await index.synchronize(next, control())).status, 'exhausted');
    assert.equal(ledger.snapshot().consumed.scannedBytes, consumed.scannedBytes);
  } finally {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});
