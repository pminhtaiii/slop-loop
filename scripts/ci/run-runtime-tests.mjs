import { globSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeTestFiles } from './test-selection.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const DEFAULT_RESULTS_FILE = 'runtime-test-results.xml';

export function runtimeTestArgs(files, resultsFile = process.env.TEST_RESULTS_FILE || DEFAULT_RESULTS_FILE) {
  // Machine-readable results (with per-test elapsed times) sit beside the human reporter, so a
  // failing lane still leaves evidence.
  return ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${resultsFile}`, ...files];
}

export function runRuntimeTests() {
  const started = Date.now();
  try {
    const source = globSync('tests/runtime/**/*.test.*', { cwd: root });
    const emitted = globSync('dist/tests/runtime/**/*.test.js', { cwd: root });
    const files = runtimeTestFiles(source, emitted);
    const resultsFile = process.env.TEST_RESULTS_FILE || DEFAULT_RESULTS_FILE;
    // The emitted inventory comes from a verified build artifact in CI; no cache may replace it.
    const result = spawnSync(process.execPath, runtimeTestArgs(files, resultsFile), { cwd: root, stdio: 'inherit', windowsHide: true });
    console.log(`Runtime lane: ${files.length} emitted test file(s) in ${Date.now() - started}ms; results in ${resultsFile}`);
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) runRuntimeTests();
