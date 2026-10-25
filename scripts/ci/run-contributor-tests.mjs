import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contributorTestFiles } from './test-selection.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function contributorTestArgs(files, progress = process.env.WORKFLOW_GATE_PROGRESS === '1') {
  const args = ['--test'];
  if (progress) {
    const reporter = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'gate-test-reporter.mjs')).href;
    args.push('--test-reporter=spec', `--test-reporter=${reporter}`, '--test-reporter-destination=stdout', '--test-reporter-destination=stderr');
  }
  return [...args, ...files];
}

export function runContributorTests() {
  try {
    const files = contributorTestFiles(root);
    const result = spawnSync(process.execPath, contributorTestArgs(files), { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) runContributorTests();
