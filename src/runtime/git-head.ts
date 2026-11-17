/**
 * The commit `--print-host-template` pins, read with plain fs so assembly makes no spawn
 * (real-tier contract §(i)). It covers a normal checkout, a worktree `.git` file with its
 * `commondir`, a detached HEAD, loose refs, `packed-refs` and chained symbolic refs. Anything
 * unresolved is `''`, which the assembly reports as `delivery-revision-unresolved`.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const COMMIT = /^[a-f0-9]{40,64}$/u;
// A ref name stays inside its git directory: `refs/` then anything `git check-ref-format` allows, so
// only control characters, space and `~^:?*[\` are excluded; `validRef` adds the sequence rules.
const REF = /^refs\/[^\x00-\x20\x7f~^:?*[\\]+$/u;
const MAX_SYMBOLIC_HOPS = 5;

/** One text file, or undefined: a missing file is a refusal, never an exception. */
const text = (path: string): string | undefined => (statSync(path, { throwIfNoEntry: false })?.isFile() === true ? readFileSync(path, 'utf8') : undefined);

/** `git check-ref-format`: no `..` or `@{`, no trailing dot, and no empty, dot-led or `.lock` segment. */
const validRef = (ref: string): boolean =>
  REF.test(ref) && !ref.includes('..') && !ref.includes('@{') && !ref.endsWith('.') && !ref.split('/').some(part => part === '' || part.startsWith('.') || part.endsWith('.lock'));

/** Git's own upward `.git` discovery, following a worktree `.git` file. */
function gitDirOf(root: string): string | undefined {
  for (let at = resolve(root); ; at = dirname(at)) {
    const candidate = join(at, '.git');
    const stat = statSync(candidate, { throwIfNoEntry: false });
    if (stat?.isDirectory() === true) return candidate;
    if (stat?.isFile() === true) {
      const pointer = /^gitdir:\s*(.+)$/mu.exec(text(candidate) ?? '')?.[1]?.trim();
      return pointer === undefined ? undefined : resolve(at, pointer);
    }
    if (dirname(at) === at) return undefined;
  }
}

/** A ref's value from a loose ref or a `packed-refs` line; `^` peel lines name no ref. */
function refValue(ref: string, gitDirs: readonly string[]): string {
  for (const dir of gitDirs) {
    const loose = text(join(dir, ref));
    if (loose !== undefined) return asciiTrim(loose);
  }
  for (const line of gitDirs.flatMap(dir => text(join(dir, 'packed-refs'))?.split('\x0a') ?? [])) {
    // A packed line is `<value> <name>` with exactly one space; the name may hold any git-legal byte.
    const trimmed = asciiTrim(line);
    const space = trimmed.indexOf(' ');
    if (space > 0 && trimmed.slice(space + 1) === ref) return trimmed.slice(0, space);
  }
  return '';
}

/** Git trims only ASCII whitespace; JS `trim` and `\s` would also eat a git-legal U+00A0 (MW4-CR-001). */
function asciiTrim(value: string): string {
  return value.replace(/^[\x09\x0a\x0d ]+|[\x09\x0a\x0d ]+$/gu, '');
}

export function gitHead(root: string): string {
  const gitDir = gitDirOf(root);
  if (gitDir === undefined) return '';
  const common = text(join(gitDir, 'commondir'))?.trim();
  // A worktree's refs live in the common directory its `commondir` file names.
  const dirs = common === undefined ? [gitDir] : [gitDir, resolve(gitDir, common)];
  let value = asciiTrim(text(join(gitDir, 'HEAD')) ?? '');
  for (let hop = 0; hop <= MAX_SYMBOLIC_HOPS; hop += 1) {
    const ref = /^ref:[\x09 ]*([^\x00-\x20]+)$/u.exec(value)?.[1];
    if (ref === undefined) return COMMIT.test(value) ? value : '';
    if (!validRef(ref)) return '';
    value = refValue(ref, dirs);
  }
  return '';
}
