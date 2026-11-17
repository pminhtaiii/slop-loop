/**
 * The spawn-free HEAD resolver the real-tier assembly pins deliveries with (STD-W4-201/202).
 * Every git directory here is a synthetic temp tree; nothing runs git.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { gitHead } from '../../../src/runtime/git-head.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'git-head-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function withTree(files: Record<string, string>, check: (root: string) => void): void {
  const root = tree(files);
  try {
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a detached HEAD, a loose ref and a packed ref each resolve', () => {
  withTree({ 'repo/.git/HEAD': `${A}\n` }, root => assert.equal(gitHead(join(root, 'repo')), A));
  withTree({ 'repo/.git/HEAD': 'ref: refs/heads/main\n', 'repo/.git/refs/heads/main': `${A}\n` }, root => assert.equal(gitHead(join(root, 'repo')), A));
  withTree({ 'repo/.git/HEAD': 'ref: refs/heads/main\n', 'repo/.git/packed-refs': `# pack-refs\n${B} refs/heads/main\n` }, root => assert.equal(gitHead(join(root, 'repo/sub')), B));
});

test('a worktree .git file reads HEAD from its gitdir and refs from its commondir', () => {
  withTree(
    {
      'main/.git/refs/heads/feature': `${B}\n`,
      'main/.git/worktrees/wt/HEAD': 'ref: refs/heads/feature\n',
      'main/.git/worktrees/wt/commondir': '../..\n',
      'wt/.git': 'gitdir: ../main/.git/worktrees/wt\n',
    },
    root => assert.equal(gitHead(join(root, 'wt')), B),
  );
});

test('STD-W4-202: a chained symbolic ref is followed to its packed commit', () => {
  withTree(
    {
      'repo/.git/HEAD': 'ref: refs/heads/alias\n',
      'repo/.git/refs/heads/alias': 'ref: refs/heads/main\n',
      'repo/.git/packed-refs': `${A} refs/heads/main\n`,
    },
    root => assert.equal(gitHead(join(root, 'repo')), A),
  );
});

test('STD-W4-201: a ref that escapes the git directory is refused, never read', () => {
  withTree({ 'repo/.git/HEAD': 'ref: ../../outside\n', outside: `${A}\n` }, root => assert.equal(gitHead(join(root, 'repo')), ''));
  withTree({ 'repo/.git/HEAD': 'ref: refs/../../../outside\n', outside: `${A}\n` }, root => assert.equal(gitHead(join(root, 'repo')), ''));
});

test('a git-legal branch name with +, @ or a dotted segment resolves; an illegal one stays unresolved', () => {
  // `git check-ref-format` accepts these, so the resolver must too (it is the pin the template prints).
  for (const name of ['refs/heads/release/v1+hotfix', 'refs/heads/fix@2', 'refs/heads/feature/a.b', 'refs/tags/v1.0+meta']) {
    withTree({ 'repo/.git/HEAD': `ref: ${name}\n`, [`repo/.git/${name}`]: `${A}\n` }, root => assert.equal(gitHead(join(root, 'repo')), A, name));
  }
  // Still contained: empty segments, `..`, a `.lock` suffix, a space, `~`, `^`, `[`, `@{`.
  for (const name of ['refs/heads//double', 'refs/heads/a/../b', 'refs/heads/branch.lock', 'refs/heads/has space', 'refs/heads/a~1', 'refs/heads/a^', 'refs/heads/a@{1}', 'refs/heads/a[1']) {
    withTree({ 'repo/.git/HEAD': `ref: ${name}\n`, [`repo/.git/${name}`]: `${A}\n` }, root => assert.equal(gitHead(join(root, 'repo')), '', name));
  }
  // `:` and `\` cannot even be a path on every platform; the name is refused before any read.
  for (const name of ['refs/heads/a:b', 'refs/heads/back\\slash', 'refs/heads/a?', 'refs/heads/a*']) {
    withTree({ 'repo/.git/HEAD': `ref: ${name}\n`, 'repo/.git/refs/heads/a': `${A}\n` }, root => assert.equal(gitHead(join(root, 'repo')), '', name));
  }
});

test('a symbolic-ref cycle and a non-commit value are unresolved', () => {
  withTree({ 'repo/.git/HEAD': 'ref: refs/heads/a\n', 'repo/.git/refs/heads/a': 'ref: refs/heads/b\n', 'repo/.git/refs/heads/b': 'ref: refs/heads/a\n' }, root =>
    assert.equal(gitHead(join(root, 'repo')), ''),
  );
  withTree({ 'repo/.git/HEAD': 'not-a-commit\n' }, root => assert.equal(gitHead(join(root, 'repo')), ''));
});
