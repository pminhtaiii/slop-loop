import assert from 'node:assert/strict';
import test from 'node:test';
import { FULL_STEPS, CLEAN_BUILD_STEPS, parseArgs, runGate } from '../../scripts/ci/check-runtime.mjs';

const root = process.cwd();

function harness({ platform = 'linux', status = 0, error } = {}) {
  const effects = [];
  const spawn = (command, args, options) => {
    effects.push({ type: 'spawn', command, args, options });
    return { status: error ? null : status, ...(error ? { error } : {}) };
  };
  const remove = (path, options) => { effects.push({ type: 'remove', path, options }); };
  return { effects, spawn, remove, platform };
}

function run(options = {}) {
  const h = harness(options);
  let thrown;
  const logged = [];
  try {
    runGate({ argv: options.argv ?? [], root, platform: h.platform, spawn: h.spawn, remove: h.remove, log: (line) => logged.push(line) });
  } catch (error) {
    thrown = error;
  }
  return { ...h, thrown, logged };
}

test('the default mode keeps the complete clean runtime gate in order', () => {
  const result = run();
  assert.equal(result.thrown, undefined);
  assert.deepEqual([...FULL_STEPS], ['typecheck', 'lint', 'build', 'test:runtime']);
  assert.equal(result.effects[0].type, 'remove', 'dist is cleaned before anything runs');
  const spawned = result.effects.slice(1);
  assert.deepEqual(spawned.map((effect) => [effect.command, effect.args]), [['pnpm', ['run', 'typecheck']], ['pnpm', ['run', 'lint']], ['pnpm', ['run', 'build']], ['pnpm', ['run', 'test:runtime']]]);
  assert.deepEqual(result.logged, ['Runtime gate: typecheck', 'Runtime gate: lint', 'Runtime gate: build', 'Runtime gate: test:runtime']);
  assert.equal(result.effects.length, 5);
});

test('clean-build-only removes stale output and builds without other gates', () => {
  const result = run({ argv: ['--clean-build-only'] });
  assert.equal(result.thrown, undefined);
  assert.deepEqual([...CLEAN_BUILD_STEPS], ['build']);
  assert.equal(result.effects[0].type, 'remove');
  assert.match(result.effects[0].path, /[\\/]dist$/);
  assert.equal(result.effects.filter((effect) => effect.type === 'spawn').length, 1);
  assert.deepEqual(result.effects[1].args, ['run', 'build']);
  assert.deepEqual(result.logged, ['Runtime gate: build']);
});

test('unknown or repeated options are denied before any effect', () => {
  for (const argv of [['--clean-build'], ['--full'], ['--clean-build-only', '--clean-build-only'], ['build'], ['--clean-build-only', 'extra'], [''], ['--help']]) {
    const result = run({ argv });
    assert.ok(result.thrown, `expected refusal for ${JSON.stringify(argv)}`);
    assert.match(result.thrown.message, /Usage/);
    assert.deepEqual(result.effects, [], `${JSON.stringify(argv)} must not touch dist or spawn`);
    assert.deepEqual(result.logged, []);
  }
  assert.throws(() => parseArgs(['--x']), /Usage/);
  assert.deepEqual([...parseArgs([])], ['typecheck', 'lint', 'build', 'test:runtime']);
  assert.deepEqual([...parseArgs(['--clean-build-only'])], ['build']);
});

test('a bounded command failure stops the gate and surfaces the failing script', () => {
  const result = run({ argv: ['--clean-build-only'], status: 2 });
  assert.equal(result.thrown?.message, 'Runtime build failed (2)');
  assert.equal(result.effects.length, 2);
  assert.deepEqual(result.logged, ['Runtime gate: build']);

  const failedFull = run({ status: 1 });
  assert.equal(failedFull.thrown?.message, 'Runtime typecheck failed (1)');
  assert.deepEqual(failedFull.logged, ['Runtime gate: typecheck']);

  const spawnError = new Error('spawn pnpm ENOENT');
  const errored = run({ error: spawnError });
  assert.equal(errored.thrown?.message, spawnError.message);
  assert.deepEqual(errored.logged, ['Runtime gate: typecheck']);
});

test('windows uses the command shim with the same fixed script names', () => {
  const result = run({ argv: ['--clean-build-only'], platform: 'win32' });
  assert.equal(result.thrown, undefined);
  assert.equal(result.effects[1].command, 'cmd.exe');
  assert.deepEqual(result.effects[1].args, ['/d', '/s', '/c', 'pnpm run build']);
  assert.equal(result.effects[1].options.timeout, 600_000);
  assert.equal(result.effects[1].options.windowsHide, true);
});

test('importing the module runs nothing', () => {
  assert.equal(typeof runGate, 'function');
  assert.equal(typeof parseArgs, 'function');
});
