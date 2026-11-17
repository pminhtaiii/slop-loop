import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createControlledQuestionEmbedding, loadLocalQuestionEmbedding } from '../../../src/questions/embedding.ts';

test('counts prefix, body and special tokens before dispatch and normalizes output', async () => {
  const serialized: string[] = [];
  let calls = 0;
  const embedding = createControlledQuestionEmbedding(
    { id: 'fixture/1', dimension: 2, maxTokens: 4 },
    text => {
      serialized.push(text);
      return text === 'query: ok' ? [1, 2, 3, 4] : [1, 2, 3, 4, 5];
    },
    () => {
      calls++;
      return [3, 4];
    },
  );
  assert.deepEqual(await embedding.embed({ kind: 'query', text: 'long' }), { status: 'overflow', tokens: 5 });
  assert.equal(calls, 0);
  const result = await embedding.embed({ kind: 'query', text: 'ok' });
  assert.deepEqual(result, { status: 'ok', tokens: 4, vector: [0.6, 0.8] });
  assert.deepEqual(serialized, ['query: long', 'query: ok']);
  assert.equal(calls, 1);
});

test('local loader rejects substituted tokenizer or model bytes before opening ONNX', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'question-embedding-'));
  try {
    await mkdir(join(directory, 'onnx'));
    await writeFile(join(directory, 'tokenizer.json'), '{}');
    await writeFile(join(directory, 'tokenizer_config.json'), '{}');
    await writeFile(join(directory, 'onnx', 'model_quantized.onnx'), 'substituted bytes');
    await assert.rejects(loadLocalQuestionEmbedding(directory, '0'.repeat(64)), /artifact pin mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discards a late result after cancellation and refuses invalid vectors', async () => {
  const controller = new AbortController();
  const cancelled = createControlledQuestionEmbedding(
    { id: 'fixture/1', dimension: 2, maxTokens: 4 },
    () => [1],
    () => {
      controller.abort();
      return [1, 0];
    },
  );
  assert.deepEqual(await cancelled.embed({ kind: 'passage', text: 'source' }, controller.signal), { status: 'cancelled' });
  for (const vector of [[0, 0], [Infinity, 0], [1]]) {
    const adapter = createControlledQuestionEmbedding(
      { id: 'fixture/1', dimension: 2, maxTokens: 4 },
      () => [1],
      () => vector,
    );
    assert.deepEqual(await adapter.embed({ kind: 'query', text: 'help' }), { status: 'invalid' });
  }
});
