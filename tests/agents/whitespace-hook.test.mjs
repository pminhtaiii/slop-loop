import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hook = resolve(repoRoot, '.githooks/pre-commit');
const sizeChecker = resolve(repoRoot, 'scripts/ci/check-staged-file-size.mjs');

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'whitespace-hook-'));
  assert.equal(dirname(root), resolve(tmpdir()));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'empty.gitconfig') };
  await writeFile(env.GIT_CONFIG_GLOBAL, '');
  const runGit = (...args) => spawnSync('git', args, { cwd: root, env, encoding: 'utf8', windowsHide: true });
  const git = (...args) => {
    const result = runGit(...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('config', 'user.name', 'Whitespace hook test');
  git('config', 'user.email', 'whitespace-hook@example.test');
  git('commit', '--quiet', '--allow-empty', '-m', 'baseline');
  await mkdir(join(root, '.githooks'));
  await copyFile(hook, join(root, '.githooks/pre-commit'));
  await chmod(join(root, '.githooks/pre-commit'), 0o755);
  await mkdir(join(root, 'scripts/ci'), { recursive: true });
  await copyFile(sizeChecker, join(root, 'scripts/ci/check-staged-file-size.mjs'));
  git('config', 'core.hooksPath', '.githooks');
  return { root, env, git, runGit };
}

test('the pre-commit hook rejects staged trailing whitespace and runs the size check', async (t) => {
  const { root, git, runGit } = await repository(t);
  await writeFile(join(root, 'src.ts'), 'const value = 1;  \n');
  git('add', '--', 'src.ts');
  const whitespaceCheck = runGit('diff', '--cached', '--check');
  assert.notEqual(whitespaceCheck.status, 0);

  const result = runGit('commit', '-m', 'trailing whitespace');
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /trailing whitespace/);
  assert.match(output, /Staged-file size check passed/);
});

test('clean staged content commits successfully', async (t) => {
  const { root, git, runGit } = await repository(t);
  await writeFile(join(root, 'src.ts'), 'const value = 1;\n');
  git('add', '--', 'src.ts');

  const result = runGit('commit', '-m', 'clean staged content');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Staged-file size check passed/);
});

test('whitespace present only in unstaged content does not block a staged commit', async (t) => {
  const { root, git, runGit } = await repository(t);
  await writeFile(join(root, 'src.ts'), 'const staged = true;\n');
  await writeFile(join(root, 'unstaged.ts'), 'const unstaged = true;  \n');
  git('add', '--', 'src.ts');

  const result = runGit('commit', '-m', 'only staged content');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(git('status', '--short'), /\?\? unstaged\.ts/);
});

test('the pre-commit hook still blocks an oversized staged implementation file', async (t) => {
  const { root, git, runGit } = await repository(t);
  await writeFile(join(root, 'src.ts'), 'x'.repeat(20_001));
  git('add', '--', 'src.ts');

  const result = runGit('commit', '-m', 'oversized staged content');
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /Staged implementation files exceed 20,000 bytes/);
  assert.match(output, /"src\.ts" \(20,001 bytes\)/);
});
