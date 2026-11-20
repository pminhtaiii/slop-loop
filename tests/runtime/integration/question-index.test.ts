import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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

test('reopened index revocation reclaims persisted data before its lazy worker starts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'question-index-lazy-revoke-'));
  const target = join(directory, 'target');
  await mkdir(target);
  let embedded = 0;
  const options = {
    databasePath: join(directory, 'index.sqlite'),
    targetRoots: [target],
    limits,
    embedding: createControlledQuestionEmbedding(
      { id: 'controlled/1', dimension: 2, maxTokens: 512 },
      () => [1],
      () => {
        embedded++;
        return [1, 0];
      },
    ),
    configDigest: digest('config'),
    embeddingDigest: digest('embedding'),
    authorize: async () => true,
  };
  let index = createQuestionIndex({ ...options, budget: budget() });
  try {
    const initial = source({ 'a.py': 'def first():\n    return 1' });
    assert.equal((await index.synchronize({ ...initial, expectedGenerationId: null }, control())).status, 'ok');
    await index.close();
    index = createQuestionIndex({ ...options, budget: budget() });
    await index.revoke();
    await index.close();
    index = createQuestionIndex({ ...options, budget: budget() });
    const fresh = await index.synchronize({ ...initial, expectedGenerationId: null }, control());
    assert.equal(fresh.status, 'ok');
    assert.equal(embedded, 2);
    const closedPath = join(directory, 'closed.sqlite');
    const closedIndex = createQuestionIndex({ ...options, databasePath: closedPath, budget: budget() });
    await closedIndex.close();
    await closedIndex.revoke();
    assert.equal(existsSync(closedPath), false);
  } finally {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function budget() {
  const result = createQuestionBudgetLedger(
    {
      schemaVersion: 'question-budget/1',
      runtime: {
        maxToolCalls: 200,
        maxModelCalls: 10,
        maxScannedFiles: 1000,
        maxScannedBytes: 10_000_000,
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
      retrieval: limits,
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

test('committed vectors survive reopen and an identical corpus rebinds without embeddings or vector writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'question-index-'));
  await mkdir(join(directory, 'target'));
  let embedded = 0;
  const embedding = createControlledQuestionEmbedding(
    { id: 'controlled/1', dimension: 2, maxTokens: 512 },
    () => [1, 2],
    () => {
      embedded++;
      return [1, 0];
    },
  );
  const options = {
    databasePath: join(directory, 'index.sqlite'),
    targetRoots: [join(directory, 'target')],
    limits,
    embedding,
    budget: budget(),
    configDigest: digest('config'),
    embeddingDigest: digest('embedding'),
    authorize: async () => true,
  };
  let index = createQuestionIndex(options);
  try {
    const initial = source({ 'a.py': 'def first():\n    return 1' });
    const saved = await index.synchronize({ ...initial, expectedGenerationId: null }, control());
    assert.equal(saved.status, 'ok');
    if (saved.status !== 'ok') return;
    assert.equal(embedded, 1);
    await index.close();
    index = createQuestionIndex({ ...options, budget: budget() });
    assert.equal((await index.read({ snapshot: initial.snapshot, generationId: saved.generation.generationId, maxChunks: 200 }, control())).status, 'stale');
    const next = source({ 'a.py': 'def first():\n    return 1' }, 'snapshot2');
    const rebound = await index.synchronize({ ...next, expectedGenerationId: saved.generation.generationId }, control());
    assert.equal(rebound.status, 'ok');
    if (rebound.status !== 'ok') return;
    assert.equal(embedded, 1);
    assert.equal(rebound.vectorWrites, 0);
    const read = await index.read({ snapshot: next.snapshot, generationId: rebound.generation.generationId, maxChunks: 200 }, control());
    assert.equal(read.status, 'ok');
    if (read.status === 'ok')
      assert.deepEqual(
        read.chunks.map(row => [row.metadata.symbolName, row.vector]),
        [['first', [1, 0]]],
      );
    await index.close();
    const replacement = createControlledQuestionEmbedding(
      { id: 'controlled/2', dimension: 1, maxTokens: 512 },
      () => [1],
      () => [1],
    );
    index = createQuestionIndex({ ...options, embedding: replacement, embeddingDigest: digest('replacement-profile'), budget: budget() });
    const rebuilt = await index.synchronize({ ...next, expectedGenerationId: rebound.generation.generationId }, control());
    assert.equal(rebuilt.status, 'ok');
    if (rebuilt.status === 'ok') assert.equal(rebuilt.vectorWrites, 1);
  } finally {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('refresh replaces edited and renamed paths, deletes missing paths and embeds only changed files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'question-index-delta-'));
  await mkdir(join(directory, 'target'));
  let embedded = 0;
  const embedding = createControlledQuestionEmbedding(
    { id: 'controlled/1', dimension: 2, maxTokens: 512 },
    () => [1],
    () => {
      embedded++;
      return [0, 1];
    },
  );
  const index = createQuestionIndex({
    databasePath: join(directory, 'index.sqlite'),
    targetRoots: [join(directory, 'target')],
    limits,
    embedding,
    budget: budget(),
    configDigest: digest('config'),
    embeddingDigest: digest('embedding'),
    authorize: async () => true,
  });
  try {
    const first = source({ 'a.py': 'def unchanged():\n    pass', 'b.py': 'def edited():\n    return 1', 'c.py': 'def renamed():\n    pass', 'd.py': 'def deleted():\n    pass' });
    const saved = await index.synchronize({ ...first, expectedGenerationId: null }, control());
    assert.equal(saved.status, 'ok');
    if (saved.status !== 'ok') return;
    assert.equal(embedded, 4);
    const next = source({ 'a.py': 'def unchanged():\n    pass', 'b.py': 'def edited():\n    return 2', 'e.py': 'def renamed():\n    pass', 'f.py': 'def added():\n    pass' }, 'next');
    const refreshed = await index.synchronize({ ...next, expectedGenerationId: saved.generation.generationId }, control());
    assert.equal(refreshed.status, 'ok');
    if (refreshed.status !== 'ok') return;
    assert.equal(embedded, 7);
    assert.equal(refreshed.vectorWrites, 3);
    assert.equal(refreshed.reusedChunks, 1);
    const read = await index.read({ snapshot: next.snapshot, generationId: refreshed.generation.generationId, maxChunks: 200 }, control());
    assert.equal(read.status, 'ok');
    if (read.status !== 'ok') return;
    assert.deepEqual(
      read.files.map(file => file.path),
      ['a.py', 'b.py', 'e.py', 'f.py'],
    );
    assert.equal((await index.read({ snapshot: next.snapshot, generationId: refreshed.generation.generationId, maxChunks: 1 }, control())).status, 'exhausted');
    const deletedOnly = source({ 'a.py': 'def unchanged():\n    pass' }, 'deleted-only');
    const pruned = await index.synchronize({ ...deletedOnly, expectedGenerationId: refreshed.generation.generationId }, control());
    assert.equal(pruned.status, 'ok');
    if (pruned.status === 'ok') {
      assert.equal(pruned.vectorWrites, 0);
      const afterDelete = await index.read({ snapshot: deletedOnly.snapshot, generationId: pruned.generation.generationId, maxChunks: 200 }, control());
      assert.equal(afterDelete.status, 'ok');
      if (afterDelete.status === 'ok')
        assert.deepEqual(
          afterDelete.files.map(file => file.path),
          ['a.py'],
        );
    }
    assert.equal((await index.validateCurrent({ snapshot: first.snapshot, generationId: saved.generation.generationId }, control())).status, 'stale');
  } finally {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('readers see the complete predecessor while update embedding is pending; stale CAS cannot publish', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'question-index-concurrent-'));
  await mkdir(join(directory, 'target'));
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let hold = false;
  const blocked = new Promise<void>(resolve => {
    entered = resolve;
  });
  const embedding = createControlledQuestionEmbedding(
    { id: 'controlled/1', dimension: 2, maxTokens: 512 },
    () => [1],
    async () => {
      if (hold) {
        entered?.();
        await new Promise<void>(resolve => {
          release = resolve;
        });
      }
      return [1, 0];
    },
  );
  const options = {
    databasePath: join(directory, 'index.sqlite'),
    targetRoots: [join(directory, 'target')],
    limits,
    embedding,
    budget: budget(),
    configDigest: digest('config'),
    embeddingDigest: digest('embedding'),
    authorize: async () => true,
  };
  const index = createQuestionIndex(options);
  const rival = createQuestionIndex({ ...options, budget: budget() });
  try {
    const first = source({ 'a.py': 'def old():\n    pass' });
    const saved = await index.synchronize({ ...first, expectedGenerationId: null }, control());
    assert.equal(saved.status, 'ok');
    if (saved.status !== 'ok') return;
    hold = true;
    const next = source({ 'a.py': 'def next():\n    pass' }, 'next');
    const updating = index.synchronize({ ...next, expectedGenerationId: saved.generation.generationId }, control());
    await blocked;
    const observed = await index.read({ snapshot: first.snapshot, generationId: saved.generation.generationId, maxChunks: 200 }, control());
    assert.equal(observed.status, 'ok');
    if (observed.status === 'ok')
      assert.deepEqual(
        observed.chunks.map(row => row.metadata.symbolName),
        ['old'],
      );
    assert.equal((await rival.synchronize({ ...next, expectedGenerationId: saved.generation.generationId }, control())).status, 'busy');
    hold = false;
    release?.();
    const committed = await updating;
    assert.equal(committed.status, 'ok');
    assert.equal((await rival.synchronize({ ...next, expectedGenerationId: saved.generation.generationId }, control())).status, 'stale');
  } finally {
    release?.();
    await index.close();
    await rival.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancelled, exhausted and stale work leaves the committed predecessor unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'question-index-refusal-'));
  await mkdir(join(directory, 'target'));
  let embedded = 0;
  const embedding = createControlledQuestionEmbedding(
    { id: 'controlled/1', dimension: 2, maxTokens: 512 },
    () => [1],
    () => {
      embedded++;
      return [1, 0];
    },
  );
  const index = createQuestionIndex({
    databasePath: join(directory, 'index.sqlite'),
    targetRoots: [join(directory, 'target')],
    limits,
    embedding,
    budget: budget(),
    configDigest: digest('config'),
    embeddingDigest: digest('embedding'),
    authorize: async () => true,
  });
  try {
    const first = source({ 'a.py': 'def old():\n    pass' });
    const saved = await index.synchronize({ ...first, expectedGenerationId: null }, control());
    assert.equal(saved.status, 'ok');
    if (saved.status !== 'ok') return;
    const next = source({ 'a.py': 'def next():\n    pass' }, 'next');
    const abort = new AbortController();
    abort.abort();
    assert.equal((await index.synchronize({ ...next, expectedGenerationId: saved.generation.generationId }, { ...control(), signal: abort.signal })).status, 'cancelled');
    assert.equal((await index.synchronize({ ...next, expectedGenerationId: saved.generation.generationId }, { ...control(), deadlineEpochMs: Date.now() - 1 })).status, 'exhausted');
    assert.equal((await index.synchronize({ ...next, expectedGenerationId: 'forged' }, control())).status, 'stale');
    assert.equal(embedded, 1);
    const read = await index.read({ snapshot: first.snapshot, generationId: saved.generation.generationId, maxChunks: 200 }, control());
    assert.equal(read.status, 'ok');
    if (read.status === 'ok')
      assert.deepEqual(
        read.chunks.map(row => row.metadata.symbolName),
        ['old'],
      );
    assert.equal((await index.read({ snapshot: first.snapshot, generationId: saved.generation.generationId, maxChunks: 0 }, control())).status, 'invalid');
  } finally {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('revocation during embedding invalidates pending publication and reclaims derived rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'question-index-revoke-'));
  await mkdir(join(directory, 'target'));
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let hold = false;
  const blocked = new Promise<void>(resolve => {
    entered = resolve;
  });
  const embedding = createControlledQuestionEmbedding(
    { id: 'controlled/1', dimension: 2, maxTokens: 512 },
    () => [1],
    async () => {
      if (hold) {
        entered?.();
        await new Promise<void>(resolve => {
          release = resolve;
        });
      }
      return [1, 0];
    },
  );
  const options = {
    databasePath: join(directory, 'index.sqlite'),
    targetRoots: [join(directory, 'target')],
    limits,
    embedding,
    budget: budget(),
    configDigest: digest('config'),
    embeddingDigest: digest('embedding'),
    authorize: async () => true,
  };
  const index = createQuestionIndex(options);
  try {
    const first = source({ 'a.py': 'def old():\n    pass' });
    const saved = await index.synchronize({ ...first, expectedGenerationId: null }, control());
    assert.equal(saved.status, 'ok');
    if (saved.status !== 'ok') return;
    hold = true;
    const next = source({ 'a.py': 'def next():\n    pass' }, 'next');
    const updating = index.synchronize({ ...next, expectedGenerationId: saved.generation.generationId }, control());
    await blocked;
    await index.revoke();
    hold = false;
    release?.();
    assert.equal((await updating).status, 'unavailable');
    assert.equal((await index.read({ snapshot: first.snapshot, generationId: saved.generation.generationId, maxChunks: 200 }, control())).status, 'unavailable');
    await index.close();
    const reopened = createQuestionIndex({ ...options, budget: budget() });
    try {
      const savedAgain = await reopened.synchronize({ ...first, expectedGenerationId: null }, control());
      assert.equal(savedAgain.status, 'ok');
      if (savedAgain.status === 'ok') assert.equal(savedAgain.vectorWrites, 1);
    } finally {
      await reopened.close();
    }
  } finally {
    release?.();
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('interrupted staged refresh is invisible and a reopened host can reclaim and revalidate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'question-index-interrupt-'));
  await mkdir(join(directory, 'target'));
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let calls = 0;
  const blocked = new Promise<void>(resolve => {
    entered = resolve;
  });
  const embedding = createControlledQuestionEmbedding(
    { id: 'controlled/1', dimension: 2, maxTokens: 512 },
    () => [1],
    async () => {
      calls++;
      if (calls === 3) {
        entered?.();
        await new Promise<void>(resolve => {
          release = resolve;
        });
      }
      return [1, 0];
    },
  );
  const options = {
    databasePath: join(directory, 'index.sqlite'),
    targetRoots: [join(directory, 'target')],
    limits,
    embedding,
    budget: budget(),
    configDigest: digest('config'),
    embeddingDigest: digest('embedding'),
    authorize: async () => true,
  };
  const index = createQuestionIndex(options);
  try {
    const first = source({ 'a.py': 'def old():\n    pass' });
    const saved = await index.synchronize({ ...first, expectedGenerationId: null }, control());
    assert.equal(saved.status, 'ok');
    if (saved.status !== 'ok') return;
    const next = source({ 'a.py': 'def next():\n    pass', 'b.py': 'def later():\n    pass' }, 'next');
    const updating = index.synchronize({ ...next, expectedGenerationId: saved.generation.generationId }, control());
    await blocked;
    await index.close();
    release?.();
    assert.equal((await updating).status, 'unavailable');
    const reopened = createQuestionIndex({ ...options, budget: budget() });
    try {
      assert.equal((await reopened.read({ snapshot: next.snapshot, generationId: saved.generation.generationId, maxChunks: 200 }, control())).status, 'stale');
      const restored = await reopened.synchronize({ ...first, expectedGenerationId: saved.generation.generationId }, control());
      assert.equal(restored.status, 'ok');
      if (restored.status !== 'ok') return;
      assert.equal(restored.vectorWrites, 0);
      const read = await reopened.read({ snapshot: first.snapshot, generationId: restored.generation.generationId, maxChunks: 200 }, control());
      assert.equal(read.status, 'ok');
      if (read.status === 'ok')
        assert.deepEqual(
          read.chunks.map(row => row.metadata.symbolName),
          ['old'],
        );
    } finally {
      await reopened.close();
    }
  } finally {
    release?.();
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('quota exhaustion, denied scope and a database inside the target refuse before embedding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'question-index-quota-'));
  await mkdir(join(directory, 'target'));
  let embedded = 0;
  const embedding = createControlledQuestionEmbedding(
    { id: 'controlled/1', dimension: 2, maxTokens: 512 },
    () => [1],
    () => {
      embedded++;
      return [1, 0];
    },
  );
  const options = {
    databasePath: join(directory, 'index.sqlite'),
    targetRoots: [join(directory, 'target')],
    limits,
    embedding,
    budget: budget(),
    configDigest: digest('config'),
    embeddingDigest: digest('embedding'),
    authorize: async () => true,
  };
  const first = source({ 'a.py': 'def first():\n    pass', 'b.py': 'def second():\n    pass' });
  const over = createQuestionIndex({ ...options, limits: { ...limits, maxFiles: 1 } });
  const denied = createQuestionIndex({ ...options, authorize: async () => false });
  const unsafe = createQuestionIndex({ ...options, databasePath: join(directory, 'target', 'index.sqlite') });
  const exhaustedBudget = budget();
  exhaustedBudget.cancel();
  const cancelled = createQuestionIndex({ ...options, budget: exhaustedBudget });
  try {
    assert.equal((await over.synchronize({ ...first, expectedGenerationId: null }, control())).status, 'invalid');
    assert.equal((await denied.synchronize({ ...first, expectedGenerationId: null }, control())).status, 'stale');
    assert.equal((await unsafe.synchronize({ ...first, expectedGenerationId: null }, control())).status, 'unavailable');
    assert.equal((await cancelled.synchronize({ ...first, expectedGenerationId: null }, control())).status, 'cancelled');
    assert.equal(embedded, 0);
  } finally {
    await Promise.all([over.close(), denied.close(), unsafe.close(), cancelled.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing persisted chunks cannot be relabeled into a new generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'question-index-corrupt-'));
  await mkdir(join(directory, 'target'));
  const embedding = createControlledQuestionEmbedding(
    { id: 'controlled/1', dimension: 2, maxTokens: 512 },
    () => [1],
    () => [1, 0],
  );
  const options = {
    databasePath: join(directory, 'index.sqlite'),
    targetRoots: [join(directory, 'target')],
    limits,
    embedding,
    budget: budget(),
    configDigest: digest('config'),
    embeddingDigest: digest('embedding'),
    authorize: async () => true,
  };
  const index = createQuestionIndex(options);
  try {
    const first = source({ 'a.py': 'def first():\n    pass' });
    const saved = await index.synchronize({ ...first, expectedGenerationId: null }, control());
    assert.equal(saved.status, 'ok');
    if (saved.status !== 'ok') return;
    await index.close();
    {
      using database = new DatabaseSync(options.databasePath);
      database.exec('DELETE FROM chunks');
    }
    const reopened = createQuestionIndex({ ...options, budget: budget() });
    try {
      assert.equal((await reopened.synchronize({ ...first, expectedGenerationId: saved.generation.generationId }, control())).status, 'unavailable');
    } finally {
      await reopened.close();
    }
  } finally {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});
