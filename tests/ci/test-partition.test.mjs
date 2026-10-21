import assert from 'node:assert/strict';
import test from 'node:test';
import { globSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contributorTestFiles, runtimeTestFiles } from '../../scripts/ci/test-selection.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const normalize = file => file.replaceAll('\\', '/');

test('contributor selection includes each helper test and excludes runtime sources', () => {
  const selected = contributorTestFiles(root);
  const repositoryTests = globSync('tests/**/*.test.*', { cwd: root }).map(normalize).sort();
  const expected = repositoryTests.filter(file => !file.startsWith('tests/runtime/'));

  assert.ok(selected.length > 0);
  assert.deepEqual(selected, expected);
  assert.equal(new Set(selected).size, selected.length);
  assert.ok(selected.every(file => file.endsWith('.test.mjs')));
});

test('runtime selection requires one emitted test for each source test', () => {
  assert.deepEqual(runtimeTestFiles(
    ['tests/runtime/unit/telemetry.test.ts', 'tests/runtime/approvals/cli.test.ts'],
    ['dist/tests/runtime/unit/telemetry.test.js', 'dist/tests/runtime/approvals/cli.test.js'],
  ), ['dist/tests/runtime/approvals/cli.test.js', 'dist/tests/runtime/unit/telemetry.test.js']);

  assert.throws(() => runtimeTestFiles(['tests/runtime/one.test.ts'], []), /missing emitted/);
  assert.throws(() => runtimeTestFiles([], ['dist/tests/runtime/orphan.test.js']), /unexpected emitted/);
  assert.throws(() => runtimeTestFiles(['tests/runtime/one.test.mjs'], []), /\.test\.ts/);
});
