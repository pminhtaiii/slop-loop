import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installGitHooks } from '../../scripts/agents/install-git-hooks.mjs';

const checker = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/ci/check-staged-file-size.mjs');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'staged-size-guard-'));
  assert.equal(dirname(root), resolve(tmpdir()));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'empty.gitconfig') };
  await writeFile(env.GIT_CONFIG_GLOBAL, '');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('config', 'user.name', 'Guard test');
  git('config', 'user.email', 'guard@example.test');
  git('commit', '--quiet', '--allow-empty', '-m', 'baseline');
  const check = (...args) => spawnSync(process.execPath, [checker, '--root', root, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const commit = () => git('commit', '--quiet', '-m', 'fixture change');
  return { root, env, git, check, commit };
}

test('the checker uses staged index bytes and allows exactly 20,000 bytes', async (t) => {
  const { root, git, check } = await repository(t);
  const unsupportedScope = check('--base', 'HEAD');
  assert.equal(unsupportedScope.status, 1, 'the checker does not accept a tree-range mode');
  assert.match(unsupportedScope.stderr, /Usage:/);

  const file = join(root, 'source with spaces.ts');
  await writeFile(file, 'x'.repeat(20_000));
  git('add', '--', 'source with spaces.ts');
  assert.equal(check().status, 0, 'the 20,000-byte boundary is allowed');

  await writeFile(file, 'x'.repeat(30_000));
  assert.equal(check().status, 0, 'unstaged working-tree bytes are ignored');

  await writeFile(file, 'x'.repeat(20_001));
  git('add', '--', 'source with spaces.ts');
  await writeFile(file, 'x');
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source with spaces\.ts/);
  assert.match(result.stderr, /20,001 bytes/);
  assert.match(result.stderr, /Split each file along a cohesive responsibility/);
  assert.match(result.stderr, /pnpm run check:staged-size/);
});

test('known generated outputs, lockfiles, and binary blobs are skipped without exempting contracts', async (t) => {
  const { root, git, check } = await repository(t);
  const tooLarge = Buffer.from('a'.repeat(20_001));
  const skipped = [
    'nested/pnpm-lock.yaml', 'node_modules/vendor/file.ts', 'dist/bundle.js', 'coverage/report.txt',
    'src/api.generated.ts', 'src/schema.g.ts',
  ];
  for (const path of skipped) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, tooLarge);
    git('add', '--', path);
  }
  const binary = Buffer.concat([tooLarge, Buffer.from([0])]);
  await mkdir(join(root, 'src/contracts'), { recursive: true });
  await writeFile(join(root, 'src/binary.dat'), binary);
  await writeFile(join(root, 'src/contracts/authored.ts'), tooLarge);
  git('add', '--', 'src/binary.dat', 'src/contracts/authored.ts');

  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/contracts\/authored\.ts/);
  for (const path of skipped) assert.doesNotMatch(result.stderr, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(result.stderr, /binary\.dat/);
});

test('renames and copies check their destination; staged deletions are ignored', async (t) => {
  const { root, git, check } = await repository(t);
  await writeFile(join(root, 'rename old.ts'), 'r'.repeat(20_000));
  await writeFile(join(root, 'copy source.ts'), 'c'.repeat(20_000));
  await writeFile(join(root, 'delete large.ts'), 'd'.repeat(20_001));
  git('add', '--', 'rename old.ts', 'copy source.ts', 'delete large.ts');
  git('commit', '--quiet', '-m', 'oversize base files are outside the staged diff');

  git('mv', '--', 'rename old.ts', 'rename target with spaces.ts');
  await writeFile(join(root, 'rename target with spaces.ts'), 'r'.repeat(20_000) + 'x');
  await writeFile(join(root, 'copy source.ts'), 'c'.repeat(19_999) + 'd');
  await writeFile(join(root, 'copy target with spaces.ts'), 'c'.repeat(20_000) + 'x');
  git('rm', '--quiet', '--', 'delete large.ts');
  git('add', '--', 'rename target with spaces.ts', 'copy source.ts', 'copy target with spaces.ts');

  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rename target with spaces\.ts/);
  assert.match(result.stderr, /copy target with spaces\.ts/);
  assert.doesNotMatch(result.stderr, /delete large\.ts/);

  git('reset', '--quiet');
  git('rm', '--cached', '--quiet', '--', 'delete large.ts');
  assert.equal(check().status, 0, 'deleting an over-limit old blob is allowed');
});

test('pnpm setup installs the repository hook and preserves custom Git hook paths', async (t) => {
  const { root, env, git } = await repository(t);
  await mkdir(join(root, '.githooks'));
  await copyFile(resolve(repoRoot, '.githooks/pre-commit'), join(root, '.githooks/pre-commit'));
  await chmod(join(root, '.githooks/pre-commit'), 0o755);
  await mkdir(join(root, 'scripts/ci'), { recursive: true });
  await copyFile(checker, join(root, 'scripts/ci/check-staged-file-size.mjs'));
  assert.deepEqual(installGitHooks(root, env), { status: 'installed' });
  assert.equal(git('config', '--get', 'core.hooksPath'), '.githooks');
  assert.deepEqual(installGitHooks(root, env), { status: 'already-configured' });

  await writeFile(join(root, 'too-large.ts'), 'x'.repeat(20_001));
  git('add', '--', 'too-large.ts');
  const blocked = spawnSync('git', ['commit', '--quiet', '-m', 'must be blocked'], { cwd: root, env, encoding: 'utf8', windowsHide: true });
  assert.notEqual(blocked.status, 0, blocked.stdout);
  assert.match(blocked.stdout + blocked.stderr, /Split each file along a cohesive responsibility/);

  await writeFile(join(root, 'too-large.ts'), 'small');
  git('add', '--', 'too-large.ts');
  const allowed = spawnSync('git', ['commit', '--quiet', '-m', 'small file passes'], { cwd: root, env, encoding: 'utf8', windowsHide: true });
  assert.equal(allowed.status, 0, allowed.stderr);

  git('config', '--local', 'core.hooksPath', 'custom-hooks');
  assert.deepEqual(installGitHooks(root, env), { status: 'custom-path-preserved', path: 'custom-hooks' });
  assert.equal(git('config', '--get', 'core.hooksPath'), 'custom-hooks');
});
