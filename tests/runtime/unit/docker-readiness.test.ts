/**
 * T060 operational preflight (real-tier contract §(i)). The two commands are fixed, so this file
 * asserts the exact argv, the bounded options, and each refusal row. No Docker runs: the spawn is a
 * double, and every value here is a synthetic `sha256:` id.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DOCKER_READINESS_OPTIONS, observeDockerReadiness } from '../../../src/foundation/docker-readiness.ts';
import type { StructuredSpawn, StructuredSpawnOptions, StructuredSpawnResult } from '../../../src/foundation/docker-controller.ts';

const IMAGE = 'sha256:' + 'a'.repeat(64);
const OTHER_IMAGE = 'sha256:' + 'b'.repeat(64);
const VERSION = '27.3.1';

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: StructuredSpawnOptions;
}

function recorder(answer: (call: Call, index: number) => Partial<StructuredSpawnResult> | Error): { readonly calls: Call[]; readonly spawn: StructuredSpawn } {
  const calls: Call[] = [];
  const spawn: StructuredSpawn = async (command, args, options) => {
    const call: Call = { command, args: [...args], options: { ...options } };
    calls.push(call);
    const override = answer(call, calls.length - 1);
    if (override instanceof Error) throw override;
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...override };
  };
  return { calls, spawn };
}

/** The daemon up and the pinned image present; per-call overrides come from each row. */
const healthy = (call: Call): Partial<StructuredSpawnResult> => (call.args[0] === 'version' ? { stdout: `${VERSION}\n` } : { stdout: `${IMAGE}\n` });

test('success runs exactly the two fixed commands and returns the version and the image ID', async () => {
  const { calls, spawn } = recorder(healthy);
  assert.deepEqual(await observeDockerReadiness(spawn, IMAGE), { ok: true, dockerServerVersion: VERSION, imageId: IMAGE });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.command, 'docker');
  assert.deepEqual(calls[0]?.args, ['version', '--format', '{{.Server.Version}}']);
  assert.deepEqual(calls[1]?.command, 'docker');
  assert.deepEqual(calls[1]?.args, ['image', 'inspect', '--format', '{{.Id}}', IMAGE]);
  for (const call of calls) {
    assert.deepEqual(call.options, { timeoutMs: 10_000, maxOutputBytes: 4_096 });
    // No shell, no stdin: the argv array is the whole command and the environment is the spawn's own.
    assert.equal(call.options.stdin, undefined);
    for (const arg of call.args) assert.doesNotMatch(arg, /[;&|><`$\r\n]/);
  }
  assert.deepEqual({ ...DOCKER_READINESS_OPTIONS }, { timeoutMs: 10_000, maxOutputBytes: 4_096 });
});

test('a down daemon is docker-unavailable from the first command alone', async () => {
  for (const override of [{ exitCode: 1 }, { exitCode: 1, stderr: 'Cannot connect to the Docker daemon' }, { timedOut: true }, { stdout: '' }, new Error('SPAWN_FAILED: docker not found')]) {
    const { calls, spawn } = recorder(call => (call.args[0] === 'version' ? override : healthy(call)));
    assert.deepEqual(await observeDockerReadiness(spawn, IMAGE), { ok: false, reasonCode: 'docker-unavailable' });
    assert.equal(calls.length, 1, 'a refused daemon query never inspects an image');
  }
});

test('a differing or missing image is image-mismatch', async () => {
  const rows: readonly ((call: Call) => Partial<StructuredSpawnResult> | Error)[] = [
    () => ({ stdout: `${OTHER_IMAGE}\n` }),
    call => (call.args[0] === 'version' ? healthy(call) : { exitCode: 1, stderr: 'No such image' }),
    call => (call.args[0] === 'version' ? healthy(call) : { timedOut: true }),
    call => (call.args[0] === 'version' ? healthy(call) : new Error('SPAWN_FAILED')),
    call => (call.args[0] === 'version' ? healthy(call) : { stdout: '' }),
  ];
  for (const row of rows) {
    const { calls, spawn } = recorder(row);
    assert.deepEqual(await observeDockerReadiness(spawn, IMAGE), { ok: false, reasonCode: 'image-mismatch' });
    assert.equal(calls.length, 2);
    // The image id is the profile's own pinned value, never something read from the command's output.
    assert.deepEqual(calls[1]?.args, ['image', 'inspect', '--format', '{{.Id}}', IMAGE]);
  }
});
