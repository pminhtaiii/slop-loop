import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('tracked dependency directories fail even when ignored; local dependencies and lockfiles pass', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tracked-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  const check = () => spawnSync(process.execPath, [resolve('scripts/ci/check-tracked-files.mjs'), '--root', root], { encoding: 'utf8', windowsHide: true });
  git('init', '--quiet');
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
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
});
