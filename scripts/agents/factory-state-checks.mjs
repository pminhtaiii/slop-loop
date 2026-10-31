import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { git, repository, samePath } from './agent-store.mjs';
import { validateOwnedPaths, validateSessionRef } from './owned-handoff.mjs';
import { verifyAssignmentBinding } from './active-task-binding.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const text = (value) => typeof value === 'string' && value.trim() === value && value.length > 0;
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const uniqueStrings = (values) => Array.isArray(values) && values.length > 0 && values.every(text) && new Set(values).size === values.length;

async function fileBytes(root, path) {
  requireValue(text(path) && !isAbsolute(path) && !path.includes('\\') && !path.includes(':') && path.split('/').every((part) => part && !['.', '..', '.git'].includes(part.toLowerCase())), `Unsafe path: ${path}`);
  let current = root;
  for (const [index, part] of path.split('/').entries()) {
    current = join(current, part);
    const stat = await lstat(current);
    requireValue(!stat.isSymbolicLink() && (index === path.split('/').length - 1 ? stat.isFile() : stat.isDirectory()), `Not a regular file: ${path}`);
  }
  return readFile(current);
}

export async function capture(root) {
  const repo = await repository(root);
  const index = git(repo.root, ['ls-files', '--stage', '-z']).stdout.split('\0').filter(Boolean).map((line) => {
    const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t(.+)$/.exec(line);
    requireValue(match && !match[3].includes('\ufffd'), 'Unsupported or malformed index entry.');
    return { path: match[3], mode: match[1], oid: match[2] };
  });
  const untracked = git(repo.root, ['ls-files', '--others', '--exclude-standard', '-z']).stdout.split('\0').filter(Boolean);
  const paths = validateOwnedPaths([...new Set([...index.map((entry) => entry.path), ...untracked])]);
  requireValue(paths.length > 0 && !paths.some((path) => path.includes('\ufffd')), 'Candidate has no files or has undecodable paths.');
  const files = [];
  for (const path of paths) {
    let bytes;
    try { bytes = await fileBytes(repo.root, path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const stat = bytes === undefined ? null : await lstat(join(repo.root, path));
    files.push({ path, sha256: bytes === undefined ? null : digest(bytes), executable: stat && process.platform !== 'win32' ? Boolean(stat.mode & 0o111) : null });
  }
  const branch = git(repo.root, ['symbolic-ref', '--quiet', 'HEAD'], true);
  const head = git(repo.root, ['rev-parse', '--verify', 'HEAD']);
  const candidate = { checkout: repo.root, repository: repo.primary, branch: branch.status === 0 ? branch.stdout.trim() : null, head: head.stdout.trim(), index, files };
  return { status: 'pass', schemaVersion: 1, candidateSha256: digest(JSON.stringify(candidate)), candidate };
}

function validateManifest(manifest) {
  requireValue(record(manifest) && manifest.schemaVersion === 1 && record(manifest.identity), 'Malformed manifest.');
  const { identity, authorization, criteria } = manifest;
  requireValue(['owner', 'task', 'session', 'checkout'].every((key) => text(identity[key])) && isAbsolute(identity.checkout), 'Malformed identity.');
  validateSessionRef(identity.session);
  requireValue(hashPattern.test(manifest.candidateSha256 ?? ''), 'Malformed candidate hash.');
  requireValue(validateOwnedPaths(manifest.ownedPaths).length > 0, 'Owned paths required.');
  requireValue(record(authorization) && authorization.declared === true && Array.isArray(authorization.sources) && authorization.sources.length > 0, 'Explicit authorization declaration and sources required.');
  const sourcePaths = authorization.sources.map((source) => {
    requireValue(record(source) && text(source.path) && hashPattern.test(source.sha256 ?? ''), 'Malformed authorization source.');
    return source.path;
  });
  requireValue(new Set(sourcePaths).size === sourcePaths.length, 'Duplicate authorization source.');
  requireValue(Array.isArray(criteria) && criteria.length > 0, 'Criteria required.');
  const ids = new Set();
  for (const criterion of criteria) {
    requireValue(record(criterion) && text(criterion.id) && !ids.has(criterion.id) && sourcePaths.includes(criterion.source) && uniqueStrings(criterion.allowedTiers) && uniqueStrings(criterion.requiredChecks), 'Malformed criterion.');
    ids.add(criterion.id);
  }
}

const key = (path) => process.platform === 'win32' ? path.toLowerCase() : path;
const overlaps = (a, b) => { a = key(a); b = key(b); return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); };
const equalIdentity = (a, b) => ['owner', 'task', 'session', 'checkout'].every((field) => a?.[field] === b?.[field]);

export async function check({ root, mode, manifestPath, manifestSha256, evidencePath, evidenceSha256 }) {
  requireValue(['dispatch', 'handoff'].includes(mode), 'Mode must be dispatch or handoff.');
  requireValue(hashPattern.test(manifestSha256 ?? ''), 'A trusted manifest hash is required.');
  const repo = await repository(root);
  const manifestBytes = await readFile(manifestPath);
  requireValue(digest(manifestBytes) === manifestSha256, 'Manifest hash mismatch.');
  const manifest = JSON.parse(manifestBytes);
  validateManifest(manifest);
  requireValue(await samePath(manifest.identity.checkout, repo.root), 'Checkout mismatch.');
  const lock = await lstat(resolve(repo.primary, '.agent-work/state/active-task.lock')).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
  requireValue(!lock, 'Active-task registry is busy.');
  const entries = JSON.parse(await fileBytes(repo.primary, '.agent-work/state/active-tasks.json'));
  requireValue(Array.isArray(entries), 'Malformed registry.');
  const matches = entries.filter((entry) => entry?.owner === manifest.identity.owner && entry?.task === manifest.identity.task);
  requireValue(matches.length === 1, 'Assignment missing or ambiguous.');
  const entry = matches[0];
  requireValue(entry.role === 'worker' && (mode === 'dispatch' ? entry.status === 'active' : ['active', 'handed-off'].includes(entry.status)) && entry.session === manifest.identity.session && await samePath(entry.checkout, repo.root), 'Assignment identity or status mismatch.');
  await verifyAssignmentBinding(entry, repo, repo.root);
  const owned = validateOwnedPaths(entry.ownedPaths);
  requireValue(JSON.stringify(owned) === JSON.stringify(validateOwnedPaths(manifest.ownedPaths)), 'Ownership mismatch.');
  for (const other of entries) {
    if (other === entry || !['active', 'blocked'].includes(other?.status)) continue;
    if ((other.role ?? 'coordinator') === 'coordinator' && !other.reservation && !other.ownedPaths?.length) continue;
    requireValue(Array.isArray(other.ownedPaths) && other.ownedPaths.length > 0, 'Another active assignment has unknown ownership.');
    requireValue(!validateOwnedPaths(other.ownedPaths).some((path) => owned.some((own) => overlaps(path, own))), `Conflicting ownership: ${other.owner}/${other.task}`);
  }
  for (const source of manifest.authorization.sources) requireValue(digest(await fileBytes(repo.root, source.path)) === source.sha256, `Authorization source changed: ${source.path}`);
  const candidate = await capture(repo.root);
  requireValue(candidate.candidateSha256 === manifest.candidateSha256, 'Candidate changed.');
  if (mode === 'handoff') {
    requireValue(hashPattern.test(evidenceSha256 ?? '') && text(evidencePath), 'Evidence and trusted evidence hash required.');
    const bytes = await readFile(evidencePath);
    requireValue(digest(bytes) === evidenceSha256, 'Evidence hash mismatch.');
    const evidence = JSON.parse(bytes);
    requireValue(record(evidence) && evidence.schemaVersion === 1 && evidence.manifestSha256 === manifestSha256 && evidence.candidateSha256 === manifest.candidateSha256 && equalIdentity(evidence.identity, manifest.identity) && Array.isArray(evidence.criteria), 'Evidence binding mismatch.');
    requireValue(evidence.criteria.length === manifest.criteria.length, 'Evidence criteria mismatch.');
    for (const criterion of manifest.criteria) {
      const found = evidence.criteria.filter((item) => item?.id === criterion.id);
      requireValue(found.length === 1 && found[0].status === 'passed' && criterion.allowedTiers.includes(found[0].tier) && Array.isArray(found[0].checks), `Missing or invalid criterion evidence: ${criterion.id}`);
      requireValue(found[0].checks.length === criterion.requiredChecks.length, `Evidence checks mismatch: ${criterion.id}`);
      for (const id of criterion.requiredChecks) {
        const checks = found[0].checks.filter((item) => item?.id === id);
        requireValue(checks.length === 1 && checks[0].status === 'passed' && text(checks[0].command) && checks[0].exitCode === 0 && Array.isArray(checks[0].artifacts) && checks[0].artifacts.length > 0, `Missing or invalid check: ${id}`);
        for (const artifact of checks[0].artifacts) {
          requireValue(record(artifact) && hashPattern.test(artifact.sha256 ?? '') && digest(await fileBytes(repo.root, artifact.path)) === artifact.sha256, `Invalid artifact for check: ${id}`);
        }
      }
    }
  }
  return { status: 'pass', mode, manifestSha256, candidateSha256: candidate.candidateSha256, provenance: 'Caller-supplied declarations and evidence are not authorization, semantic acceptance, or execution attestation.' };
}
