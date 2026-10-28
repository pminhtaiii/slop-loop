import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { commonGitDirectory, verifyAssignmentBinding } from './active-task-binding.mjs';
import { samePath } from './agent-store.mjs';
import { validateOwnedPaths, validateSessionRef } from './owned-handoff.mjs';

const maxExtensions = 32;
const maxPathsPerExtension = 16;
const maxPathLength = 1024;
const maxReasonLength = 1024;

function pathKey(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function normalizedPaths(paths) {
  const result = validateOwnedPaths(paths);
  if (result.length > maxPathsPerExtension || result.some((path) => path.length > maxPathLength)) {
    throw new Error(`An ownership extension may add at most ${maxPathsPerExtension} paths of at most ${maxPathLength} characters each.`);
  }
  const keys = result.map(pathKey);
  if (new Set(keys).size !== keys.length) throw new Error('Owned paths must be unique for this platform.');
  return result;
}

function normalizedReason(reason) {
  if (typeof reason !== 'string') throw new Error('Ownership extension requires a bounded --reason.');
  const value = reason.trim();
  // eslint-disable-next-line no-control-regex
  if (!value || value.length > maxReasonLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Ownership extension reason must be one line of 1-${maxReasonLength} characters.`);
  }
  return value;
}

function samePathSet(left, right) {
  return left.length === right.length && left.every((path, index) => pathKey(path) === pathKey(right[index]));
}

export function validateOwnershipExtensions(entry) {
  if (entry.ownershipExtensions === undefined) return;
  const records = entry.ownershipExtensions;
  if (!Array.isArray(records) || records.length > maxExtensions) throw new Error('Invalid or oversized ownership extension history.');
  const owned = new Set(validateOwnedPaths(entry.ownedPaths ?? []).map(pathKey));
  const seen = new Set();
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).sort().join('\0') !== ['at', 'paths', 'reason'].join('\0')) {
      throw new Error('Invalid ownership extension history; file left unchanged.');
    }
    const paths = normalizedPaths(record.paths);
    if (!paths.length || paths.join('\0') !== record.paths.join('\0') || typeof record.reason !== 'string' ||
        record.reason !== normalizedReason(record.reason) || typeof record.at !== 'string' ||
        !Number.isFinite(Date.parse(record.at)) || new Date(record.at).toISOString() !== record.at) {
      throw new Error('Invalid ownership extension history; file left unchanged.');
    }
    for (const path of paths) {
      const key = pathKey(path);
      if (!owned.has(key) || seen.has(key)) throw new Error('Ownership extension history does not match declared paths.');
      seen.add(key);
    }
  }
}

async function verifyNewPaths(repo, paths) {
  for (const path of paths) {
    let current = repo.root;
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      current = resolve(current, parts[index]);
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if (error.code === 'ENOENT') break;
        throw error;
      }
      if (info.isSymbolicLink()) throw new Error(`Owned path must not pass through a symbolic link: ${path}.`);
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error(`Owned path parent is not a directory: ${path}.`);
      if (index === parts.length - 1 && !info.isFile()) throw new Error(`Owned path must be a regular file: ${path}.`);
    }
  }
}

async function sharesRepository(entry, repository) {
  const recorded = entry.binding?.repository ?? entry.reservation?.repository;
  const checkouts = [entry.checkout, entry.reservation?.coordinatorCheckout, entry.reservation?.primaryCheckout].filter(Boolean);
  let actual;
  for (const checkout of checkouts) {
    try {
      const common = await commonGitDirectory(checkout);
      if (actual && !await samePath(actual, common)) return true;
      actual = common;
    } catch {
      continue;
    }
  }
  if (actual) return recorded && !await samePath(actual, recorded) ? true : await samePath(actual, repository);
  if (checkouts.length) return true;
  return recorded ? samePath(recorded, repository) : true;
}

export async function addOwnedPaths(entries, entry, repo, requested, reasonInput) {
  if (entry.status !== 'active' || entry.role !== 'worker') throw new Error('Owned paths can be extended only for an active worker assignment.');
  if (!entry.session) throw new Error('Owned path extension requires a matching registered session.');
  validateSessionRef(entry.session);
  if (entry.handoffEvidence !== undefined) throw new Error('An assignment with handoff evidence cannot extend its owned paths.');
  const binding = await verifyAssignmentBinding(entry, repo, repo.root);
  if (binding.identity.session !== entry.session || !await samePath(binding.checkout, repo.root)) {
    throw new Error('Owned path extension must run in the assignment checkout with its matching session binding.');
  }

  const paths = normalizedPaths(requested);
  if (!paths.length) throw new Error('At least one --add-owned-path is required.');
  const reason = normalizedReason(reasonInput);
  await verifyNewPaths(repo, paths);

  const ownedPaths = validateOwnedPaths(entry.ownedPaths ?? []);
  const owned = new Set(ownedPaths.map(pathKey));
  const history = entry.ownershipExtensions ?? [];
  const prior = history.find((record) => samePathSet(record.paths, paths) && record.reason === reason);
  if (prior && paths.every((path) => owned.has(pathKey(path)))) return { added: false, paths, at: prior.at };
  if (paths.some((path) => owned.has(pathKey(path)))) throw new Error('One or more paths are already owned; no ownership was changed.');
  if (history.length >= maxExtensions) throw new Error(`Ownership extension history is full (${maxExtensions}); no ownership was changed.`);

  const repository = await commonGitDirectory(repo.root);
  for (const other of entries) {
    if (other === entry || !['active', 'blocked'].includes(other.status)) continue;
    if (!await sharesRepository(other, repository)) continue;
    const otherPaths = other.ownedPaths;
    const statusOnlyCoordinator = (other.role ?? 'coordinator') === 'coordinator' && !other.reservation;
    if (!Array.isArray(otherPaths) || !otherPaths.length) {
      if (statusOnlyCoordinator) continue;
      throw new Error(`Cannot extend ownership while ${other.owner}/${other.task} has unknown owned paths in this repository.`);
    }
    const otherOwned = validateOwnedPaths(otherPaths);
    const overlap = paths.some((path) => otherOwned.some((otherPath) => {
      const left = pathKey(path);
      const right = pathKey(otherPath);
      return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
    }));
    if (overlap) throw new Error(`Owned path conflicts with active assignment ${other.owner}/${other.task}; no ownership was changed.`);
  }

  const at = new Date().toISOString();
  entry.ownedPaths = validateOwnedPaths([...ownedPaths, ...paths]);
  entry.ownershipExtensions = [...history, { paths, reason, at }];
  return { added: true, paths, at };
}

export async function updateOwnedPaths(entries, entry, repo, values) {
  const extension = await addOwnedPaths(entries, entry, repo, values['add-owned-path'], values.reason);
  if (extension.added || values.next || values.verification || values.status) return true;
  console.log(JSON.stringify({ owner: entry.owner, task: entry.task, added: false, paths: extension.paths, at: extension.at }));
  return false;
}
