/**
 * The commit `--print-host-template` pins, read with plain fs so assembly makes no spawn
 * (real-tier contract §(i)). It covers a normal checkout, a worktree `.git` file with its
 * `commondir`, a detached HEAD, loose refs, `packed-refs` and chained symbolic refs. Anything
 * unresolved is `''`, which the assembly reports as `delivery-revision-unresolved`.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const COMMIT = /^[a-f0-9]{40,64}$/u;
// A ref name stays inside its git directory: `refs/` then plain segments, never `..` or a lock file.
const REF = /^refs\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/u;
const MAX_SYMBOLIC_HOPS = 5;

/** One text file, or undefined: a missing file is a refusal, never an exception. */
const text = (path: string): string | undefined => (statSync(path, { throwIfNoEntry: false })?.isFile() === true ? readFileSync(path, 'utf8') : undefined);

const validRef = (ref: string): boolean => REF.test(ref) && !ref.split('/').some(part => part.includes('..') || part.endsWith('.lock'));

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
    const loose = text(join(dir, ref))?.trim();
    if (loose !== undefined) return loose;
  }
  for (const line of gitDirs.flatMap(dir => text(join(dir, 'packed-refs'))?.split('\n') ?? [])) {
    const [value, name] = line.trim().split(/\s+/u);
    if (name === ref && value !== undefined) return value;
  }
  return '';
}

export function gitHead(root: string): string {
  const gitDir = gitDirOf(root);
  if (gitDir === undefined) return '';
  const common = text(join(gitDir, 'commondir'))?.trim();
  // A worktree's refs live in the common directory its `commondir` file names.
  const dirs = common === undefined ? [gitDir] : [gitDir, resolve(gitDir, common)];
  let value = text(join(gitDir, 'HEAD'))?.trim() ?? '';
  for (let hop = 0; hop <= MAX_SYMBOLIC_HOPS; hop += 1) {
    const ref = /^ref:\s*(\S+)$/u.exec(value)?.[1];
    if (ref === undefined) return COMMIT.test(value) ? value : '';
    if (!validRef(ref)) return '';
    value = refValue(ref, dirs);
  }
  return '';
}
