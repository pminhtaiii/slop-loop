import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createIndexClient, waitForIndexControl } from '../../../src/questions/index-client.ts';

for (const ending of ['cancel', 'deadline'] as const) {
  test(`an already ${ending === 'cancel' ? 'cancelled' : 'expired'} wait consumes the pending owner rejection`, () => {
    const source = new URL(import.meta.url.endsWith('.ts') ? '../../../src/questions/index-client.ts' : '../../../src/questions/index-client.js', import.meta.url).href;
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { waitForIndexControl } from ${JSON.stringify(source)};
      const abort = new AbortController();
      if (${JSON.stringify(ending)} === 'cancel') abort.abort();
      let rejected = 0;
      process.on('unhandledRejection', () => { rejected++; });
      const result = await waitForIndexControl(Promise.reject(new Error('controlled owner failure')), {
        signal: abort.signal, deadlineEpochMs: Date.now() + (${JSON.stringify(ending)} === 'deadline' ? -1 : 1000),
      });
      await new Promise(resolve => setImmediate(resolve));
      process.stdout.write(JSON.stringify({ result, rejected }));
    `,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout), { result: ending === 'cancel' ? { status: 'cancelled', reasonCode: 'cancelled' } : { status: 'exhausted', reasonCode: 'deadline' }, rejected: 0 });
  });
}

test('a live wait still propagates an owner rejection', async () => {
  await assert.rejects(
    waitForIndexControl(Promise.reject(new Error('controlled owner failure')), {
      signal: new AbortController().signal,
      deadlineEpochMs: Date.now() + 1000,
    }),
    /controlled owner failure/,
  );
});

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
  maxIndexDeadlineMs: 5000,
  maxRetrievalDeadlineMs: 5000,
};

for (const ending of ['cancel', 'deadline'] as const) {
  test(`one caller's ${ending} while the worker starts does not poison another caller`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'question-client-'));
    await mkdir(join(directory, 'target'));
    let stops = 0;
    const client = createIndexClient({ databasePath: join(directory, 'index.sqlite'), targetRoots: [join(directory, 'target')], limits }, () => {
      stops++;
    });
    const abort = new AbortController();
    try {
      const short = client.rpc({ kind: 'current' }, { signal: abort.signal, deadlineEpochMs: Date.now() + (ending === 'deadline' ? 1 : 5000) });
      const long = client.rpc({ kind: 'current' }, { signal: new AbortController().signal, deadlineEpochMs: Date.now() + 5000 });
      if (ending === 'cancel') abort.abort();
      const ended = await short;
      assert.deepEqual(ended, ending === 'cancel' ? { status: 'cancelled', reasonCode: 'cancelled' } : { status: 'exhausted', reasonCode: 'deadline' });
      assert.equal((await long).status, 'ok');
      assert.equal(stops, 0);
    } finally {
      await client.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('authority waits release abort listeners after successful and cancelled waits', async () => {
  const abort = new AbortController();
  let listeners = 0;
  const signal = abort.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => {
    listeners++;
    add(...args);
  };
  signal.removeEventListener = (...args) => {
    listeners--;
    remove(...args);
  };
  assert.equal(await waitForIndexControl(Promise.resolve(true), { signal, deadlineEpochMs: Date.now() + 1000 }), true);
  assert.equal(listeners, 0);
  const pending = waitForIndexControl(new Promise<never>(() => undefined), { signal, deadlineEpochMs: Date.now() + 1000 });
  abort.abort();
  assert.deepEqual(await pending, { status: 'cancelled', reasonCode: 'cancelled' });
  assert.equal(listeners, 0);
});
