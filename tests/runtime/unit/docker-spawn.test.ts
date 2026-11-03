import test from 'node:test';
import assert from 'node:assert/strict';
import { structuredSpawn } from '../../../src/foundation/docker-spawn.ts';

const NODE = process.execPath;
const OPTS = { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 };

test('each argv element reaches the child verbatim, with no shell parsing', async () => {
  const script = 'console.log(JSON.stringify(process.argv.slice(1)))';
  const values = ['a b', 'x; echo pwned', '$(whoami)', 'quote"d', 'line\nbreak'];
  const result = await structuredSpawn(NODE, ['-e', script, ...values], OPTS);

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.deepEqual(JSON.parse(result.stdout), values);
});

test('a non-zero exit resolves with its exit code instead of throwing', async () => {
  const result = await structuredSpawn(NODE, ['-e', 'process.exit(3)'], OPTS);
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
});

test('exceeding timeoutMs kills the child and resolves with timedOut', async () => {
  const started = Date.now();
  const result = await structuredSpawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], { ...OPTS, timeoutMs: 300 });

  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  assert.ok(Date.now() - started < 5_000);
});

test('output beyond maxOutputBytes is capped on a UTF-8 boundary and flagged truncated', async () => {
  const script = "process.stdout.write('a'.repeat(90) + '€'.repeat(10)); process.stderr.write('e'.repeat(500))";
  const result = await structuredSpawn(NODE, ['-e', script], { ...OPTS, maxOutputBytes: 100 });

  assert.equal(result.truncated, true);
  assert.equal(result.stdout, `${'a'.repeat(90)}€€€`);
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 100);
  assert.equal(result.stderr, 'e'.repeat(100));
});

test('stdin is written and ended, and an absent stdin is closed rather than left open', async () => {
  const roundTrip = await structuredSpawn(NODE, ['-e', 'process.stdin.pipe(process.stdout)'], { ...OPTS, stdin: 'héllo\n' });
  assert.equal(roundTrip.stdout, 'héllo\n');

  const script = "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'))";
  const closed = await structuredSpawn(NODE, ['-e', script], OPTS);
  assert.equal(closed.stdout, 'eof');
});

test('a nonexistent command rejects with a message naming it', async () => {
  const missing = 'slop-loop-definitely-not-a-command';
  await assert.rejects(structuredSpawn(missing, [], OPTS), new RegExp(`SPAWN_FAILED.*${missing}`));
});
