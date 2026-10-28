import assert from 'node:assert/strict';
import test from 'node:test';
import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

test('contributor runner executes through a symlink, propagates failures and stays inert on import', async t => {
  const fixture = await mkdtemp(resolve(tmpdir(), 'contributor-runner-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const scripts = resolve(fixture, 'scripts/ci');
  await mkdir(scripts, { recursive: true });
  await mkdir(resolve(fixture, 'tests'));
  for (const file of ['run-contributor-tests.mjs', 'test-selection.mjs']) {
    await copyFile(resolve(root, 'scripts/ci', file), resolve(scripts, file));
  }
  const entry = resolve(scripts, 'run-contributor-tests.mjs');
  const alias = resolve(fixture, 'runner-link.mjs');
  try { await symlink(entry, alias, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('File symlinks unavailable.');
    throw error;
  }
  const env = { ...process.env, WORKFLOW_GATE_PROGRESS: '0' };
  delete env.NODE_TEST_CONTEXT;
  const run = args => spawnSync(process.execPath, args, { cwd: fixture, encoding: 'utf8', windowsHide: true, env });
  for (const fail of [false, true]) {
    await writeFile(resolve(fixture, 'tests/fixture.test.mjs'), `import test from 'node:test';\ntest('selected fixture', () => { ${fail ? "throw new Error('fixture failure');" : ''} });\n`);
    for (const path of [entry, alias]) {
      const result = run([path]);
      assert.equal(result.status, fail ? 1 : 0, result.stderr);
      assert.match(result.stdout, /selected fixture/);
    }
  }
  const imported = run(['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(alias).href)})`]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
});
