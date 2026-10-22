import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { git, samePath } from './agent-store.mjs';

export const originDevelopmentBaseRef = 'refs/remotes/origin/development';
const commitPattern = /^[0-9a-f]{40,64}$/i;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function identity(entry) {
  return { owner: entry.owner, task: entry.task, session: entry.session };
}

function sameIdentity(left, right) {
  return isRecord(left) && left.owner === right.owner && left.task === right.task && left.session === right.session;
}

function validRepositoryPath(path) {
  return typeof path === 'string' && path.length > 0 && resolve(path) === path;
}

function validBase(base, reservation = false) {
  if (!isRecord(base) || typeof base.ref !== 'string') return false;
  if (reservation && base.ref !== originDevelopmentBaseRef) return false;
  if (!reservation && base.ref === 'existing-checkout') return base.sha === null || typeof base.sha === 'string' && commitPattern.test(base.sha);
  return base.ref === originDevelopmentBaseRef && typeof base.sha === 'string' && commitPattern.test(base.sha);
}

export function validateBindingMetadata(entry) {
  if (entry.reservation !== undefined) {
    const reservation = entry.reservation;
    if (!isRecord(reservation) || reservation.schemaVersion !== 1 || !sameIdentity(reservation.identity, identity(entry)) ||
        !validRepositoryPath(reservation.repository) || !validBase(reservation.base, true)) {
      throw new Error('Invalid active-task reservation identity or base.');
    }
    if (!entry.binding && (entry.checkout !== undefined || entry.head !== undefined)) throw new Error('An unbound reservation cannot claim a checkout or HEAD.');
  }
  if (entry.binding !== undefined) {
    const binding = entry.binding;
    if (!isRecord(binding) || binding.schemaVersion !== 1 || !sameIdentity(binding.identity, identity(entry)) ||
        !validRepositoryPath(binding.checkout) || !validRepositoryPath(binding.repository) ||
        binding.branch !== null && (typeof binding.branch !== 'string' || !binding.branch.startsWith('refs/heads/')) ||
        !validBase(binding.base) || typeof binding.boundAt !== 'string' || binding.checkout !== entry.checkout) {
      throw new Error('Invalid active-task binding identity.');
    }
    if (entry.reservation && (binding.repository !== entry.reservation.repository || JSON.stringify(binding.base) !== JSON.stringify(entry.reservation.base))) {
      throw new Error('Active-task binding does not match its reservation base.');
    }
  } else if (entry.checkout !== undefined && entry.reservation) {
    throw new Error('An unbound reservation cannot claim a checkout.');
  }
}

export async function commonGitDirectory(root) {
  const directory = git(root, ['rev-parse', '--git-common-dir']).stdout.trim();
  return realpath(resolve(root, directory));
}

function pathKey(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function realDirectory(path, label) {
  const requested = resolve(path);
  const stat = await lstat(requested).catch((error) => {
    if (error.code === 'ENOENT') throw new Error(`${label} does not exist.`);
    throw error;
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory, not a symbolic link.`);
  const canonical = await realpath(requested);
  if (pathKey(canonical) !== pathKey(requested)) throw new Error(`${label} must not use a symbolic-link path.`);
  return canonical;
}

async function inspectWorktree(repo, requestedPath, { requireBranch = false } = {}) {
  const path = await realDirectory(requestedPath, 'Worker worktree');
  const record = repo.worktrees.find((item) => item.worktree && pathKey(item.worktree) === pathKey(path));
  if (!record || Object.hasOwn(record, 'locked') || Object.hasOwn(record, 'prunable')) throw new Error('Worker must be a registered, unlocked Git worktree in the same repository.');
  const top = await realpath(git(path, ['rev-parse', '--show-toplevel']).stdout.trim());
  if (pathKey(top) !== pathKey(path)) throw new Error('Worker path must be the Git worktree root.');
  const branchResult = git(path, ['symbolic-ref', '--quiet', 'HEAD'], true);
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : null;
  if (branch && record.branch && branch !== record.branch) throw new Error('Worker branch changed during binding.');
  if (requireBranch && !branch) throw new Error('Worker must be on a registered Git branch.');
  const headResult = git(path, ['rev-parse', '--verify', 'HEAD^{commit}'], true);
  const head = headResult.status === 0 ? headResult.stdout.trim() : null;
  return { path, branch, head, repository: await commonGitDirectory(path) };
}

export async function reserveBinding(repo, entry, baseSha) {
  if (!commitPattern.test(baseSha ?? '')) throw new Error('reserve requires a full fetched origin/development commit SHA.');
  try {
    git(repo.root, ['fetch', '--no-tags', 'origin', `+refs/heads/development:${originDevelopmentBaseRef}`]);
  } catch {
    throw new Error('Could not fetch origin/development; reservation was not written.');
  }
  let currentHead;
  let fetchedHead;
  try {
    currentHead = git(repo.root, ['rev-parse', '--verify', 'HEAD^{commit}']).stdout.trim();
    fetchedHead = git(repo.root, ['rev-parse', '--verify', `${originDevelopmentBaseRef}^{commit}`]).stdout.trim();
  } catch {
    throw new Error('Fetched origin/development is unavailable after fetch; reservation was not written.');
  }
  if (currentHead !== baseSha || fetchedHead !== baseSha) {
    throw new Error('The parent checkout and freshly fetched origin/development must both match the reserved base SHA exactly.');
  }
  return {
    schemaVersion: 1,
    identity: identity(entry),
    repository: await commonGitDirectory(repo.root),
    base: { ref: originDevelopmentBaseRef, sha: baseSha },
  };
}

export async function startBinding(repo, entry) {
  const current = await inspectWorktree(repo, repo.root);
  return {
    schemaVersion: 1,
    identity: identity(entry),
    checkout: current.path,
    repository: current.repository,
    branch: current.branch,
    base: { ref: 'existing-checkout', sha: current.head },
    boundAt: new Date().toISOString(),
  };
}

export async function bindAssignment(entry, repo, worktreePath) {
  validateBindingMetadata(entry);
  if (!['active', 'blocked'].includes(entry.status) || entry.role !== 'worker') throw new Error('Only active or blocked worker assignments can bind a worktree.');
  if (entry.binding) throw new Error('Assignment is already bound; retain its worktree identity.');
  const targetPath = resolve(repo.root, worktreePath);
  if (entry.checkout && !(await samePath(entry.checkout, targetPath))) throw new Error('Binding cannot relocate an existing assignment checkout.');
  const current = await inspectWorktree(repo, targetPath, { requireBranch: Boolean(entry.reservation) });
  const repository = await commonGitDirectory(repo.root);
  if (current.repository !== repository) throw new Error('Worker worktree belongs to a different Git repository.');
  let base = { ref: 'existing-checkout', sha: current.head };
  if (entry.reservation) {
    const reserved = entry.reservation;
    if (!sameIdentity(reserved.identity, identity(entry)) || reserved.repository !== current.repository) throw new Error('Worker repository or reservation identity changed before binding.');
    if (current.head !== reserved.base.sha) throw new Error('Worker HEAD does not match the immutable reserved base.');
    if (git(current.path, ['status', '--porcelain', '--untracked-files=all']).stdout.trim()) throw new Error('Worker worktree must be clean before binding and editing.');
    base = reserved.base;
  } else if (!entry.checkout) {
    throw new Error('An unbound worker must reserve first; an existing checkout can bind only in place.');
  }
  const binding = {
    schemaVersion: 1,
    identity: identity(entry),
    checkout: current.path,
    repository: current.repository,
    branch: current.branch,
    base,
    boundAt: new Date().toISOString(),
  };
  entry.checkout = current.path;
  entry.binding = binding;
  return binding;
}

export async function verifyAssignmentBinding(entry, repo, currentCheckout) {
  validateBindingMetadata(entry);
  const binding = entry.binding;
  if (!binding) throw new Error('Worker assignment is unbound; bind its actual Git worktree before editing or handoff.');
  if (currentCheckout && !(await samePath(currentCheckout, binding.checkout))) throw new Error('Command must run in the bound worker checkout.');
  const current = await inspectWorktree(repo, binding.checkout);
  if (pathKey(current.path) !== pathKey(binding.checkout) || current.repository !== binding.repository || current.branch !== binding.branch) {
    throw new Error('Bound worker checkout, repository, or branch identity changed.');
  }
  if (binding.base.sha && (!current.head || git(current.path, ['merge-base', '--is-ancestor', binding.base.sha, current.head], true).status !== 0)) {
    throw new Error('Worker HEAD no longer descends from its immutable creation base.');
  }
  return binding;
}

export async function registeredAssignmentBase(entry, current) {
  validateBindingMetadata(entry);
  const provenance = entry.binding ?? entry.reservation;
  if (!provenance) return current.head;
  if (provenance.repository !== current.repository) throw new Error('Registered worker belongs to a different Git repository than its assignment.');
  if (entry.binding) {
    if (!(await samePath(entry.checkout, current.path)) || !(await samePath(entry.binding.checkout, current.path)) || entry.binding.branch !== current.branch) {
      throw new Error('Registered worker path or branch does not match its active-task binding.');
    }
    if (entry.binding.base.sha && (!current.head || git(current.path, ['merge-base', '--is-ancestor', entry.binding.base.sha, current.head], true).status !== 0)) {
      throw new Error('Registered worker does not descend from its immutable creation base.');
    }
  } else if (current.head !== entry.reservation.base.sha) {
    throw new Error('Reserved worker must be registered at its exact creation base before edits.');
  }
  return provenance.base.sha;
}
