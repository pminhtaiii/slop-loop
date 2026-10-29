import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contributorTestArgs } from '../../scripts/ci/run-contributor-tests.mjs';
import { PROGRESS_PREFIX } from '../../scripts/agents/workflow-gate-progress.mjs';

test('contributor runner adds progress only when WORKFLOW_GATE_PROGRESS is exactly 1', () => {
  const files = ['tests/fake.test.mjs'];
  const previous = process.env.WORKFLOW_GATE_PROGRESS;
  const previousResults = process.env.TEST_RESULTS_FILE;
  try {
    delete process.env.WORKFLOW_GATE_PROGRESS;
    // Machine-readable results are unconditional; only the progress reporters are gated.
    const results = ['--test-reporter=junit', '--test-reporter-destination=contributor-test-results.xml'];
    assert.deepEqual(contributorTestArgs(files), ['--test', ...results, ...files]);
    process.env.WORKFLOW_GATE_PROGRESS = 'true';
    assert.deepEqual(contributorTestArgs(files), ['--test', ...results, ...files]);
    process.env.TEST_RESULTS_FILE = 'custom-results.xml';
    assert.deepEqual(contributorTestArgs(files), ['--test', '--test-reporter=junit', '--test-reporter-destination=custom-results.xml', ...files]);
    delete process.env.TEST_RESULTS_FILE;
    process.env.WORKFLOW_GATE_PROGRESS = '1';
    const managed = contributorTestArgs(files);
    assert.deepEqual(managed.slice(-1), files);
    assert.ok(managed.includes('--test-reporter=spec'));
    assert.ok(managed.includes('--test-reporter-destination=stdout'));
    const reporter = managed.find(value => value.startsWith('--test-reporter=file:'));
    assert.ok(reporter);
    assert.ok(fileURLToPath(reporter.slice('--test-reporter='.length)).replaceAll('\\', '/').endsWith('scripts/ci/gate-test-reporter.mjs'));
    assert.ok(managed.includes('--test-reporter-destination=stderr'));
    assert.ok(managed.includes('--test-reporter=junit'), 'results survive a failing lane even with progress on');
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_GATE_PROGRESS;
    else process.env.WORKFLOW_GATE_PROGRESS = previous;
    if (previousResults === undefined) delete process.env.TEST_RESULTS_FILE;
    else process.env.TEST_RESULTS_FILE = previousResults;
  }
});

test('custom reporter emits bounded test lifecycle events beside visible human failure output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gate-reporter-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, 'fixture.test.mjs');
  await writeFile(fixture, [
    "import test from 'node:test';",
    "test('passes safely', () => { process.stderr.write('RAW_FIXTURE_OUTPUT_MARKER'); });",
    "test('fails visibly', () => { throw new Error('fixture failure marker'); });",
    `test('unsafe\\nname ${'x'.repeat(400)}', () => {});`,
    '',
  ].join('\n'), 'utf8');

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, contributorTestArgs([fixture], true), { cwd: directory, env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /passes safely/);
  assert.match(result.stdout, /fails visibly/);
  assert.match(result.stdout, /fixture failure marker/);
  const lines = result.stderr.split(/\r?\n/).filter(line => line.startsWith(PROGRESS_PREFIX));
  const events = lines.map(line => JSON.parse(line.slice(PROGRESS_PREFIX.length)));
  assert.ok(events.some(event => event.type === 'test:start'));
  assert.ok(events.some(event => event.type === 'test:pass'));
  assert.ok(events.some(event => event.type === 'test:fail'));
  assert.ok(lines.every(line => line.length <= 512), 'event lines remain bounded');
  assert.ok(events.every(event => !event.test.includes('\n') && event.test.length <= 160));
  assert.ok(!lines.join('\n').includes('RAW_FIXTURE_OUTPUT_MARKER'));
  assert.ok(!lines.join('\n').includes('fixture failure marker'));
  assert.ok(events.every(event => !event.file.includes(directory)), 'fixture paths do not expose the temporary absolute directory');
});
