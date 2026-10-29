import assert from 'node:assert/strict';
import test from 'node:test';
import { globSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

test('missing, orphan and duplicate emission inside a lane are all refused', () => {
  // Missing: a source with no counterpart.
  assert.throws(() => runtimeTestFiles(['tests/runtime/a.test.ts', 'tests/runtime/b.test.ts'], ['dist/tests/runtime/a.test.js']), /missing emitted: dist\/tests\/runtime\/b\.test\.js/);
  // Orphan: an emitted file whose source is gone.
  assert.throws(() => runtimeTestFiles(['tests/runtime/a.test.ts'], ['dist/tests/runtime/a.test.js', 'dist/tests/runtime/old.test.js']), /unexpected emitted: dist\/tests\/runtime\/old\.test\.js/);
  // Duplicate emission: two identical emitted entries must not collapse into one silently.
  assert.throws(() => runtimeTestFiles(['tests/runtime/a.test.ts'], ['dist/tests/runtime/a.test.js', 'dist/tests/runtime/a.test.js']), /mismatch/);
  // A duplicate name in the same lane is still exactly-once.
  assert.throws(() => runtimeTestFiles(['tests/runtime/a.test.ts', 'tests/runtime/a.test.ts'], ['dist/tests/runtime/a.test.js']), /mismatch/);
  // Emission under the wrong root is not accepted.
  assert.throws(() => runtimeTestFiles(['tests/runtime/a.test.ts'], ['tests/runtime/a.test.js']), /missing emitted/);
  // An empty inventory is a failure, not a vacuous pass.
  assert.throws(() => runtimeTestFiles([], []), /No runtime source tests found/);
});

test('contributor and runtime inventories are disjoint and deliberately repeat across OS lanes only', () => {
  const contributor = contributorTestFiles(root);
  const runtimeSources = globSync('tests/runtime/**/*.test.*', { cwd: root }).map(normalize).sort();
  assert.equal(contributor.some(file => file.startsWith('tests/runtime/')), false, 'no runtime test enters the contributor lane');
  assert.ok(runtimeSources.length > 0);
  assert.equal(runtimeSources.some(file => contributor.includes(file)), false, 'the two lanes never overlap');

  // The transition deliberately runs each OS lane twice (old job + new lane); that duplication is
  // counted separately and never used to claim exactly-once outside a canonical lane.
  const perOs = { contributor, runtime: runtimeSources };
  for (const [lane, files] of Object.entries(perOs)) {
    assert.equal(new Set(files).size, files.length, `${lane} lane is exactly-once inside one runner`);
  }
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

test('a lane leaves machine-readable results and elapsed diagnostics on pass and on failure', async t => {
  const fixture = await mkdtemp(resolve(tmpdir(), 'lane-results-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const scripts = resolve(fixture, 'scripts/ci');
  await mkdir(scripts, { recursive: true });
  await mkdir(resolve(fixture, 'tests/runtime'), { recursive: true });
  await mkdir(resolve(fixture, 'dist/tests/runtime'), { recursive: true });
  for (const file of ['run-contributor-tests.mjs', 'run-runtime-tests.mjs', 'test-selection.mjs']) {
    await copyFile(resolve(root, 'scripts/ci', file), resolve(scripts, file));
  }
  const base = { ...process.env, WORKFLOW_GATE_PROGRESS: '0' };
  delete base.NODE_TEST_CONTEXT;

  for (const fail of [false, true]) {
    const body = fail ? "throw new Error('lane failure');" : '';
    await writeFile(join(fixture, 'tests/one.test.mjs'), `import test from 'node:test';\ntest('contributor lane check', () => { ${body} });\n`);
    await writeFile(join(fixture, 'tests/runtime/one.test.ts'), 'export const one = 1;\n');
    await writeFile(join(fixture, 'dist/tests/runtime/one.test.js'), `import test from 'node:test';\ntest('runtime lane check', () => { ${body} });\n`);

    for (const [lane, entry, results] of [
      ['contributor', 'run-contributor-tests.mjs', 'contributor-results.xml'],
      ['runtime', 'run-runtime-tests.mjs', 'runtime-results.xml'],
    ]) {
      const result = spawnSync(process.execPath, [resolve(scripts, entry)], { cwd: fixture, encoding: 'utf8', windowsHide: true, env: { ...base, TEST_RESULTS_FILE: results } });
      assert.equal(result.status, fail ? 1 : 0, `${lane} ${fail ? 'propagates' : 'passes'}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`${lane === 'contributor' ? 'Contributor' : 'Runtime'} lane: 1 (?:emitted )?test file\\(s\\) in \\d+ms; results in ${results}`), `${lane} reports elapsed time and where results went`);
      const report = readFileSync(join(fixture, results), 'utf8');
      assert.match(report, /<testsuite/, `${lane} wrote machine-readable results`);
      assert.match(report, /<testcase/, `${lane} recorded the test case`);
      if (fail) assert.match(report, /<failure/, `${lane} records the failure rather than only printing it`);
    }
  }
});
