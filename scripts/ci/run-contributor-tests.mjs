import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contributorTestFiles } from './test-selection.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const DEFAULT_RESULTS_FILE = 'contributor-test-results.xml';

export function contributorTestArgs(files, progress = process.env.WORKFLOW_GATE_PROGRESS === '1', resultsFile = process.env.TEST_RESULTS_FILE || DEFAULT_RESULTS_FILE) {
  // The human reporter is unconditional: CI logs and the symlink/failure regressions read it.
  const reporters = [['spec', 'stdout']];
  if (progress) {
    const reporter = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'gate-test-reporter.mjs')).href;
    reporters.push([reporter, 'stderr']);
  }
  // Machine-readable results survive a failing lane; elapsed durations are the JUnit time attributes.
  if (resultsFile) reporters.push(['junit', resultsFile]);
  return ['--test', ...reporters.flatMap(([name, destination]) => [`--test-reporter=${name}`, `--test-reporter-destination=${destination}`]), ...files];
}

export function runContributorTests() {
  const started = Date.now();
  try {
    const files = contributorTestFiles(root);
    const resultsFile = process.env.TEST_RESULTS_FILE || DEFAULT_RESULTS_FILE;
    const result = spawnSync(process.execPath, contributorTestArgs(files, undefined, resultsFile), { cwd: root, stdio: 'inherit', windowsHide: true });
    console.log(`Contributor lane: ${files.length} test file(s) in ${Date.now() - started}ms; results in ${resultsFile}`);
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) runContributorTests();
