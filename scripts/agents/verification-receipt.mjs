import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { repository, samePath } from './agent-store.mjs';
import { verifyAssignmentBinding } from './active-task-binding.mjs';
import { validateSessionRef } from './owned-handoff.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const statuses = new Set(['passed', 'failed', 'blocked', 'not-run']);
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const distinctIds = values => Array.isArray(values) && values.every(text) && new Set(values).size === values.length;

function localPath(root, input) {
  requireValue(text(input), 'Unsafe evidence path.');
  const path = isAbsolute(input) ? relative(root, input).replaceAll('\\', '/') : input;
  requireValue(!path.includes('\\') && !path.includes(':') && path.split('/').every(part => part && !['.', '..', '.git'].includes(part.toLowerCase())), `Unsafe evidence path: ${input}`);
  return path;
}

async function bytesAt(root, input) {
  const path = localPath(root, input);
  let current = root;
  const parts = path.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await lstat(current);
    requireValue(!stat.isSymbolicLink() && (index === parts.length - 1 ? stat.isFile() : stat.isDirectory()), `Evidence must use regular files without linked parents: ${path}`);
  }
  return readFile(current);
}

async function pinnedFile(root, entry, label) {
  requireValue(object(entry) && hash(entry.sha256), `Malformed ${label} hash.`);
  const bytes = await bytesAt(root, entry.path);
  requireValue(digest(bytes) === entry.sha256, `${label} hash mismatch: ${entry.path}`);
  return bytes;
}

function validateManifest(manifest) {
  requireValue(object(manifest) && manifest.schemaVersion === 1 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.head ?? ''), 'Malformed verification manifest.');
  const actor = value => object(value) && text(value.owner) && text(value.agentId);
  requireValue(
    actor(manifest.coordinator) && actor(manifest.merger) && Array.isArray(manifest.implementers) && manifest.implementers.length > 0 && manifest.implementers.every(actor),
    'Manifest requires coordinator, implementers and merger identities.',
  );
  const others = [manifest.coordinator, ...manifest.implementers];
  requireValue(
    others.every(other => other.owner !== manifest.merger.owner && other.agentId !== manifest.merger.agentId),
    'Merger owner and host agent must be distinct from coordinator and implementers.',
  );
  requireValue(text(manifest.merger.task), 'Merger task required.');
  validateSessionRef(manifest.merger.session);
  for (const name of ['sources', 'inputs']) {
    requireValue(Array.isArray(manifest[name]) && manifest[name].length > 0 && manifest[name].every(entry => object(entry) && text(entry.path) && hash(entry.sha256)), `Manifest ${name} required.`);
    requireValue(distinctIds(manifest[name].map(entry => entry.path)), `Duplicate manifest ${name}.`);
  }
  requireValue(Array.isArray(manifest.criteria) && manifest.criteria.length > 0 && manifest.criteria.every(criterion => object(criterion) && text(criterion.id)), 'Manifest criteria required.');
  requireValue(distinctIds(manifest.criteria.map(criterion => criterion.id)), 'Duplicate manifest criteria.');
  for (const criterion of manifest.criteria) {
    requireValue(manifest.sources.some(source => source.path === criterion.source) && text(criterion.expected), `Criterion requires factory-owned source and expected result: ${criterion.id}`);
    requireValue(
      distinctIds(criterion.allowedTiers) && criterion.allowedTiers.length > 0 && distinctIds(criterion.requiredChecks) && criterion.requiredChecks.length > 0,
      `Criterion tiers and required checks required: ${criterion.id}`,
    );
  }
}

async function validateActors(root, manifest) {
  const repo = await repository(root);
  const entries = JSON.parse(await bytesAt(repo.primary, '.agent-work/state/active-tasks.json'));
  requireValue(Array.isArray(entries), 'Malformed assignment registry.');
  const coordinator = entries.filter(
    entry => entry?.owner === manifest.coordinator.owner && entry.role === 'coordinator' && entry.session === manifest.merger.session && ['active', 'blocked', 'completed'].includes(entry.status),
  );
  requireValue(coordinator.length === 1 && (await samePath(coordinator[0].checkout, root)), 'Verification requires a registered coordinator in this checkout and session.');
  const matches = entries.filter(
    entry =>
      entry?.owner === manifest.merger.owner &&
      entry.task === manifest.merger.task &&
      entry.session === manifest.merger.session &&
      entry.role === 'worker' &&
      ['active', 'blocked', 'handed-off', 'completed'].includes(entry.status),
  );
  requireValue(matches.length === 1 && (await samePath(matches[0].checkout, root)), 'Verification requires a registered merger in this checkout and session.');
  await verifyAssignmentBinding(matches[0], repo, root);
}

async function validateEvidence({ root, git, manifestPath, manifestSha256, receiptPath, receiptSha256 }) {
  requireValue(git('status', '--porcelain', '--untracked-files=all') === '', 'Verification requires a clean committed candidate.');
  const manifestBytes = await pinnedFile(root, { path: manifestPath, sha256: manifestSha256 }, 'Manifest');
  const manifest = JSON.parse(manifestBytes);
  validateManifest(manifest);
  const head = git('rev-parse', 'HEAD');
  requireValue(manifest.head === head, 'Verification manifest head does not match current candidate.');
  await validateActors(root, manifest);
  for (const source of manifest.sources) await pinnedFile(root, source, 'Source');
  for (const input of manifest.inputs) await pinnedFile(root, input, 'Input');
  const receiptBytes = await bytesAt(root, receiptPath);
  if (receiptSha256 !== undefined) requireValue(digest(receiptBytes) === receiptSha256, 'Receipt hash mismatch.');
  const receipt = JSON.parse(receiptBytes);
  requireValue(
    object(receipt) && receipt.schemaVersion === 1 && receipt.head === head && receipt.manifestSha256 === manifestSha256 && Array.isArray(receipt.criteria),
    'Receipt candidate or manifest binding mismatch.',
  );
  requireValue(
    receipt.criteria.every(criterion => object(criterion) && manifest.criteria.some(expected => expected.id === criterion.id)) && distinctIds(receipt.criteria.map(criterion => criterion.id)),
    'Unknown or duplicate evidence criteria.',
  );
  const criteria = [];
  for (const expected of manifest.criteria) {
    const found = receipt.criteria.find(criterion => criterion.id === expected.id);
    if (!found) {
      criteria.push({ id: expected.id, source: expected.source, expected: expected.expected, observed: 'No retained evidence.', status: 'not-run', tier: null });
      continue;
    }
    requireValue(
      statuses.has(found.status) && text(found.observed) && expected.allowedTiers.includes(found.tier) && Array.isArray(found.checks),
      `Invalid criterion status, observation or tier: ${expected.id}`,
    );
    requireValue(
      found.checks.every(check => object(check) && expected.requiredChecks.includes(check.id)) && distinctIds(found.checks.map(check => check.id)),
      `Unknown or duplicate checks: ${expected.id}`,
    );
    if (found.status === 'passed') requireValue(found.checks.length === expected.requiredChecks.length, `Passing criterion requires all required checks: ${expected.id}`);
    for (const check of found.checks) {
      requireValue(
        statuses.has(check.status) && text(check.command) && (check.exitCode === null || Number.isInteger(check.exitCode)) && Array.isArray(check.artifacts),
        `Malformed check: ${check.id}`,
      );
      if (found.status === 'passed') requireValue(check.status === 'passed' && check.exitCode === 0 && check.artifacts.length > 0, `Criterion requires a passing check with artifacts: ${check.id}`);
      for (const artifact of check.artifacts) await pinnedFile(root, artifact, 'Artifact');
    }
    criteria.push({ id: expected.id, source: expected.source, expected: expected.expected, observed: found.observed, status: found.status, tier: found.tier });
  }
  requireValue(git('rev-parse', 'HEAD') === head && git('status', '--porcelain', '--untracked-files=all') === '', 'Candidate changed while verifying evidence.');
  return { head, merger: manifest.merger, criteria, receiptSha256: digest(receiptBytes) };
}

/** Records candidate-bound merger evidence; incomplete results remain reportable, never a completion pass. */
export async function recordVerificationReceipt({ root, git, receiptPath, manifestPath, manifestSha256 }) {
  const paths = { manifestPath: localPath(root, manifestPath), receiptPath: localPath(root, receiptPath) };
  const result = await validateEvidence({ root, git, ...paths, manifestSha256 });
  return { schemaVersion: 1, ...result, ...paths, manifestSha256, recordedAt: new Date().toISOString() };
}

/** Revalidates retained files, assignment identity and current candidate before contributor completion. */
export async function verifyVerificationReceipt({ root, git, verification }) {
  requireValue(object(verification) && verification.schemaVersion === 1 && hash(verification.receiptSha256), 'Completion requires a retained merger verification receipt; run record-verification.');
  requireValue(verification.head === git('rev-parse', 'HEAD'), 'Merger verification head does not match current candidate.');
  const { manifestPath, manifestSha256, receiptPath, receiptSha256 } = verification;
  const result = await validateEvidence({ root, git, manifestPath, manifestSha256, receiptPath, receiptSha256 });
  const summary = verificationSummary(result);
  requireValue(summary.status === 'passed', 'Merger verification incomplete; required criteria lack passing evidence.');
  return summary;
}

/** Summarizes retained criterion results without treating publication or CI status as task acceptance. */
export function verificationSummary(verification) {
  const criteria = verification?.criteria ?? [];
  return { head: verification?.head ?? null, status: criteria.length > 0 && criteria.every(criterion => criterion.status === 'passed') ? 'passed' : 'incomplete', criteria };
}
