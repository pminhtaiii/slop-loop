import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { git, samePath } from './agent-store.mjs';
import { checkAgainstLockedRegistry } from './factory-state-checks.mjs';

export const usage = `Usage: node scripts/agents/active-task.mjs <command> [options]
Commands:
  start --owner <id> --task <id> --session <date/id> --summary <text> --next <text> [--role coordinator|worker] [--owned-path <path>...] [--factory-managed] [--expected-branch <branch> --expected-head <sha> --require-clean]
  reserve --owner <id> --task <id> --session <date/id> --base-sha <sha> --summary <text> --next <text> --owned-path <path>... [--factory-managed]
  pin-factory-handoff --owner <id> --task <id> --manifest <file> --evidence <file>
  bind --owner <id> --task <id> --worktree <absolute-path>
  edit-ready|verify-handoff --owner <id> --task <id>
  update --owner <id> --task <id> [--next <text>] [--verification <text>] [--status active|blocked] [--add-owned-path <path>... --reason <text>]
  handoff|finish --owner <id> --task <id> --result <text>
  reassign --owner <id> --task <id> --new-owner <id> --session <date/id> --reason <text>
  retire-reassigned --owner <id> --task <id> --reason <text>
  clear --owner <id> --task <id>
  archive --owner <id> --task <id> --output docs/verification/<name>.json [--apply]
  migrate-legacy|list [--compact]|render [--output .agent-work/<date>/<session>/progress.md]
All commands accept --root <checkout>. reserve fetches/pins origin/development; bind rejects coordinator paths. Reserved workers require clean pre-edit readiness before handoff; start remains in-place.
Factory-managed handoffs require coordinator-pinned manifest and evidence. The coordinator runs pin-factory-handoff locally; it does not authenticate an OS identity.
finish requires a published linked PR and passing current-head CI. Archive/clear require terminal state; reassignment preserves history; busy locks are never reclaimed.`;

const text = (value) => typeof value === 'string' && value.trim() === value && value.length > 0;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;

export function takeStartFlags(args) {
  const count = (flag) => args.filter((argument) => argument === flag).length;
  const factoryManaged = count('--factory-managed');
  const requireClean = count('--require-clean');
  const branchIndex = args.indexOf('--expected-branch');
  const headIndex = args.indexOf('--expected-head');
  if (factoryManaged > 1 || requireClean > 1 || count('--expected-branch') > 1 || count('--expected-head') > 1) throw new Error('Duplicate start guard option.');
  const expectedBranch = branchIndex < 0 ? undefined : args[branchIndex + 1];
  const expectedHead = headIndex < 0 ? undefined : args[headIndex + 1];
  const guarded = Boolean(requireClean || branchIndex >= 0 || headIndex >= 0);
  if (factoryManaged && !['start', 'reserve'].includes(args[0])) throw new Error('--factory-managed is valid only with worker start or reserve.');
  if (guarded && (args[0] !== 'start' || requireClean !== 1 || branchIndex < 0 || headIndex < 0 || !text(expectedBranch) || expectedBranch.startsWith('--') || !/^[a-f0-9]{40,64}$/i.test(expectedHead ?? ''))) {
    throw new Error('Guarded start requires --expected-branch, a full --expected-head, and --require-clean.');
  }
  const removed = new Set([args.indexOf('--factory-managed'), args.indexOf('--require-clean'), ...(branchIndex >= 0 ? [branchIndex, branchIndex + 1] : []), ...(headIndex >= 0 ? [headIndex, headIndex + 1] : [])].filter((index) => index >= 0));
  return { args: args.filter((_, index) => !removed.has(index)), factoryManaged: factoryManaged === 1, requireClean: requireClean === 1, expectedBranch, expectedHead };
}

export function validateFactoryAssignment(entry) {
  if (entry.factoryManaged !== undefined && entry.factoryManaged !== true) throw new Error('Invalid factory-managed assignment marker; file left unchanged.');
  if (entry.factoryManaged === true && entry.role !== 'worker') throw new Error('Factory-managed assignments must belong to workers; file left unchanged.');
  if (entry.factoryHandoff !== undefined && entry.factoryManaged !== true) throw new Error('Factory handoff pins require a factory-managed assignment; file left unchanged.');
  if (entry.factoryHandoff !== undefined) {
    const pin = entry.factoryHandoff;
    if (!pin || typeof pin !== 'object' || Array.isArray(pin) || pin.schemaVersion !== 1 || !text(pin.manifestPath) || !isAbsolute(pin.manifestPath) || !hashPattern.test(pin.manifestSha256 ?? '') || !text(pin.evidencePath) || !isAbsolute(pin.evidencePath) || !hashPattern.test(pin.evidenceSha256 ?? '')) {
      throw new Error('Invalid factory handoff pin; file left unchanged.');
    }
  }
}

export function preserveFactoryManaged(source, successor) {
  if (source.factoryManaged !== true) return;
  if (successor.role !== 'worker') throw new Error('Factory-managed assignments must remain worker assignments when reassigned.');
  successor.factoryManaged = true;
}

export async function verifyGuardedStart(entry, repo, options) {
  if (!options.requireClean) return;
  const binding = entry.binding;
  if (!binding || !(await samePath(binding.checkout, repo.root))) throw new Error('Guarded start must bind the current checkout before registration.');
  const branchResult = git(repo.root, ['symbolic-ref', '--quiet', 'HEAD'], true);
  const headResult = git(repo.root, ['rev-parse', '--verify', 'HEAD^{commit}'], true);
  if (branchResult.status !== 0 || headResult.status !== 0) throw new Error('Guarded start requires a branch and a full current HEAD; no assignment was written.');
  const branch = branchResult.stdout.trim();
  const head = headResult.stdout.trim();
  if (branch !== binding.branch || head !== binding.base.sha) throw new Error('Checkout identity changed while guarded start was binding; no assignment was written.');
  if (branch !== `refs/heads/${options.expectedBranch}`) throw new Error('Current branch does not match --expected-branch; no assignment was written.');
  if (head.toLowerCase() !== options.expectedHead.toLowerCase()) throw new Error('Current HEAD does not match --expected-head; no assignment was written.');
  if (git(repo.root, ['status', '--porcelain', '--untracked-files=all']).stdout.trim()) throw new Error('Guarded worker start requires a clean checkout; no assignment was written.');
  const confirmedBranch = git(repo.root, ['symbolic-ref', '--quiet', 'HEAD'], true);
  const confirmedHead = git(repo.root, ['rev-parse', '--verify', 'HEAD^{commit}'], true);
  if (confirmedBranch.status !== 0 || confirmedHead.status !== 0 || confirmedBranch.stdout.trim() !== branch || confirmedHead.stdout.trim() !== head) {
    throw new Error('Checkout identity changed during guarded start; no assignment was written.');
  }
}

async function regularReference(path, root) {
  if (!text(path) || path.includes('\0')) throw new Error('Factory evidence references must be nonempty file paths.');
  const target = resolve(root, path);
  const pathRoot = parse(target).root;
  const parts = target.slice(pathRoot.length).split(/[\\/]+/).filter(Boolean);
  let current = pathRoot;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) {
      throw new Error('Factory manifest and evidence references must be regular files without linked path components.');
    }
  }
  if (!parts.length) throw new Error('Factory evidence references must be regular files.');
  return target;
}

async function checkPin(entry, entries, root, pin) {
  validateFactoryAssignment(entry);
  if (entry.factoryManaged !== true || entry.role !== 'worker') throw new Error('Factory checks require an opted-in worker assignment.');
  const manifestPath = await regularReference(pin.manifestPath, root);
  const evidencePath = await regularReference(pin.evidencePath, root);
  return checkAgainstLockedRegistry({ root, mode: 'handoff', manifestPath, manifestSha256: pin.manifestSha256, evidencePath, evidenceSha256: pin.evidenceSha256 }, entries);
}

export async function pinFactoryHandoff(entry, entries, repo, values) {
  if (entry.status !== 'active') throw new Error('Only active factory-managed worker assignments can pin handoff evidence.');
  if (entry.factoryManaged !== true || entry.role !== 'worker') throw new Error('Only opted-in worker assignments can pin factory handoff evidence.');
  const pin = {
    schemaVersion: 1,
    manifestPath: await regularReference(values.manifest, repo.root),
    evidencePath: await regularReference(values.evidence, repo.root),
  };
  pin.manifestSha256 = digest(await readFile(pin.manifestPath));
  pin.evidenceSha256 = digest(await readFile(pin.evidencePath));
  await checkPin(entry, entries, repo.root, pin);
  entry.factoryHandoff = pin;
}

export async function verifyFactoryHandoff(entry, entries, repo) {
  validateFactoryAssignment(entry);
  if (entry.factoryManaged !== true) return;
  if (!entry.factoryHandoff) throw new Error('Factory-managed handoff is missing coordinator-pinned manifest and evidence.');
  await checkPin(entry, entries, repo.root, entry.factoryHandoff);
}
