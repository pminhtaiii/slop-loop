import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Binds a build artifact to (repositoryId, runId, runAttempt, head, OS) plus a hash manifest, so a
// dependent lane can refuse a download from another run, attempt, OS, repository or source.
export const IDENTITY_FILE = 'artifact-identity.json';
// `dist/src` and `dist/eval` are required too: emitted tests import the compiled source and the
// evaluation runner, so a lane receiving only the emitted test tree would fail with
// ERR_MODULE_NOT_FOUND instead of running.
export const ARTIFACT_PATHS = Object.freeze(['tests/runtime', 'dist/tests/runtime', 'dist/src', 'dist/eval']);
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const positive = (value, field) => {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) throw new Error(`Artifact identity needs a positive integer ${field}.`);
  return Number(value);
};
const sha = (value, field, optional = false) => {
  if (optional && (value === undefined || value === '')) return undefined;
  if (typeof value !== 'string' || !SHA.test(value)) throw new Error(`Artifact identity needs a 40- or 64-character hexadecimal ${field}.`);
  return value;
};

export function artifactIdentity(env = {}) {
  const os = env.RUNNER_OS_LABEL;
  if (typeof os !== 'string' || !/^[a-z0-9-]+$/.test(os)) throw new Error('Artifact identity needs a plain lowercase OS label.');
  const base = sha(env.BASE_SHA, 'base', true);
  const merge = sha(env.MERGE_SHA, 'merge', true);
  return Object.freeze({
    repositoryId: positive(env.REPOSITORY_ID, 'repositoryId'),
    runId: positive(env.RUN_ID, 'runId'),
    runAttempt: positive(env.RUN_ATTEMPT, 'runAttempt'),
    head: sha(env.HEAD_SHA, 'head'),
    ...(base === undefined ? {} : { base }),
    ...(merge === undefined ? {} : { merge }),
    os,
  });
}

function walk(root, relative) {
  const files = [];
  const visit = (directory, prefix) => {
    let entries;
    try {
      entries = readdirSync(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort()) {
      const absolute = join(directory, entry);
      const path = `${prefix}/${entry}`;
      if (statSync(absolute).isDirectory()) visit(absolute, path);
      else files.push(path);
    }
  };
  visit(join(root, relative), relative);
  return files;
}

const digest = (root, path) => createHash('sha256').update(readFileSync(join(root, path))).digest('hex');

// Every file this lane ships, in a stable order, keyed by its artifact-relative path.
export function manifestOf(root, paths = ARTIFACT_PATHS) {
  const files = paths.flatMap((path) => walk(root, path)).sort();
  if (!files.length) throw new Error(`No artifact files found under ${paths.join(', ')}.`);
  return files.map((path) => ({ path, sha256: digest(root, path) }));
}

export function writeIdentity({ root, env = process.env, paths = ARTIFACT_PATHS }) {
  const identity = artifactIdentity(env);
  const files = manifestOf(root, paths);
  writeFileSync(join(root, IDENTITY_FILE), `${JSON.stringify({ schemaVersion: 1, identity, files }, null, 2)}\n`);
  return { identity, files };
}

function sameIdentity(recorded, expected) {
  const keys = new Set([...Object.keys(recorded), ...Object.keys(expected)]);
  return [...keys].every((key) => recorded[key] === expected[key]);
}

export function verifyIdentity({ root, env = process.env, paths = ARTIFACT_PATHS }) {
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(join(root, IDENTITY_FILE), 'utf8'));
  } catch (error) {
    throw new Error(`Artifact identity is missing or unreadable: ${error.message}`, { cause: error });
  }
  if (recorded?.schemaVersion !== 1 || !recorded.identity || !Array.isArray(recorded.files)) {
    throw new Error('Artifact identity record has an unsupported shape.');
  }
  const expected = artifactIdentity(env);
  if (!sameIdentity(recorded.identity, expected)) {
    throw new Error(`Artifact identity does not match this run: recorded ${JSON.stringify(recorded.identity)}, expected ${JSON.stringify(expected)}.`);
  }
  const actual = manifestOf(root, paths);
  const recordedByPath = new Map(recorded.files.map((file) => [file.path, file.sha256]));
  if (recordedByPath.size !== recorded.files.length) throw new Error('Artifact manifest lists a duplicate path.');
  const missing = [...recordedByPath.keys()].filter((path) => !actual.some((file) => file.path === path));
  const orphan = actual.filter((file) => !recordedByPath.has(file.path)).map((file) => file.path);
  const tampered = actual.filter((file) => recordedByPath.has(file.path) && recordedByPath.get(file.path) !== file.sha256).map((file) => file.path);
  if (missing.length || orphan.length || tampered.length) {
    throw new Error(`Artifact integrity failed; missing: ${missing.join(', ') || 'none'}; orphan: ${orphan.join(', ') || 'none'}; tampered: ${tampered.join(', ') || 'none'}.`);
  }
  return recorded.identity;
}

const USAGE = 'Usage: node scripts/ci/artifact-identity.mjs <write|verify> [--dir <artifact root>]';

export function parseArtifactArgs(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 3) throw new Error(USAGE);
  const [command, flag, directory] = argv;
  if (!['write', 'verify'].includes(command)) throw new Error(USAGE);
  if (flag === undefined) return { command, dir: process.cwd() };
  if (flag !== '--dir' || typeof directory !== 'string' || !directory) throw new Error(USAGE);
  return { command, dir: directory };
}

// Same entry guard shape as the lane runners and the runtime gate.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const { command, dir } = parseArtifactArgs(process.argv.slice(2));
    const root = resolve(dir);
    const { identity, files } = command === 'write'
      ? writeIdentity({ root })
      : { identity: verifyIdentity({ root }), files: [] };
    console.log(`${command === 'write' ? 'Wrote' : 'Verified'} artifact identity for ${files.length || 'recorded'} file(s): ${JSON.stringify(identity)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
