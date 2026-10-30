import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { isRejectedEnvPath } from '../../scripts/ci/check-tracked-files.mjs';

const CANARY = 'CANARY_LOCAL_VALUE=never-read';

// A direct oracle for the classification itself, independent of how many names the diagnostic samples.
test('every environment basename containing .env is rejected except the exact example', () => {
  const refused = [
    '.env', '.env.local', '.env.production', '.env~', '.env-bak', '.envrc', '.env (copy)',
    '.env.中', 'foo.env', 'notes.env.txt', 'sub.env.txt', 'App.ENV', '.ENV.EXAMPLE',
    'config/.env.example.local', 'config/nested/deep/.env.example.md', '.envelope',
  ];
  for (const path of refused) assert.equal(isRejectedEnvPath(path), true, `${path} must be refused`);
  for (const path of ['.env.example', 'config/.env.example', 'environment.md', 'src/env-config.ts', 'docs/environment.md']) {
    assert.equal(isRejectedEnvPath(path), false, `${path} must be admitted`);
  }
});

test('force-added dependencies and verification records fail; local artifacts and lockfiles pass', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tracked-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  const check = () => spawnSync(process.execPath, [resolve('scripts/ci/check-tracked-files.mjs'), '--root', root], { encoding: 'utf8', windowsHide: true });
  git('init', '--quiet');
  await writeFile(join(root, '.gitignore'), 'node_modules/\ndocs/verification/\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await mkdir(join(root, 'packages/app/node_modules/lib'), { recursive: true });
  await writeFile(join(root, 'packages/app/node_modules/lib/index.js'), 'export {};\n');
  git('add', '.gitignore', 'pnpm-lock.yaml');
  let result = check();
  assert.equal(result.status, 0, result.stderr);
  git('add', '-f', 'packages/app/node_modules/lib/index.js');
  result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /packages\/app\/node_modules\/lib\/index.js/);
  git('rm', '--cached', '--quiet', 'packages/app/node_modules/lib/index.js');
  assert.equal(check().status, 0);
  await mkdir(join(root, 'docs/verification'), { recursive: true });
  await writeFile(join(root, 'docs/verification/local.md'), 'local evidence');
  assert.equal(check().status, 0, 'ignored local evidence is permitted');
  git('add', '-f', 'docs/verification/local.md');
  result = check();
  assert.equal(result.status, 1, 'force-added evidence must fail');
  assert.match(result.stderr, /docs\/verification\/local.md/);
  git('rm', '--cached', '--quiet', 'docs/verification/local.md');
  assert.equal(check().status, 0);
});

test('environment basenames are rejected except the exact lowercase example', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tracked-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  const check = () => spawnSync(process.execPath, [resolve('scripts/ci/check-tracked-files.mjs'), '--root', root], { encoding: 'utf8', windowsHide: true });
  const tracked = [
    '.env',
    'config/.env.local',
    'config/nested/deep/App.ENV',
    'config/nested/deep/.ENV.EXAMPLE',
    'config/nested/.env.production',
    // Suffixes that are not a dot used to escape the basename pattern entirely.
    'config/.env~',
    'config/.env-bak',
    'config/.envrc',
    'config/notes.env.txt',
  ];
  git('init', '--quiet');
  await writeFile(join(root, '.gitignore'), '.env\n.env.*\n*.env\n*.env.*\n');
  await mkdir(join(root, 'config/nested/deep'), { recursive: true });
  for (const path of tracked) await writeFile(join(root, path), `${CANARY}\n`);
  await writeFile(join(root, 'config/.env.example'), '# admitted example\nKEY=CHANGE_ME\n');
  git('add', '.gitignore');
  git('add', '-f', 'config/.env.example');
  assert.equal(check().status, 0, 'the exact lowercase example is admitted');
  assert.equal(check().status, 0, 'ignored local env files are never opened');
  git('add', '-f', ...tracked);
  const result = check();
  assert.equal(result.status, 1);
  // The diagnostic samples at most five names, so assert on the bounded sample rather than all nine.
  assert.match(result.stderr, /Environment files must remain untracked \(9 paths\): ".*?"/, 'the diagnostic names the policy and the true count');
  assert.equal((result.stderr.match(/"/g) ?? []).length <= 10, true, 'the sample is bounded');
  assert.ok(!result.stderr.includes('CANARY_LOCAL_VALUE'), 'diagnostics must not include file content');
  git('rm', '--cached', '--quiet', ...tracked);
  assert.equal(check().status, 0, 'removing tracked env files restores the check');
});
