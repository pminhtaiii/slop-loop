import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { IDENTITY_FILE, artifactIdentity, manifestOf, parseArtifactArgs, verifyIdentity, writeIdentity } from '../../scripts/ci/artifact-identity.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const merge = 'c'.repeat(40);

const env = (overrides = {}) => ({
  REPOSITORY_ID: '1419608901',
  RUN_ID: '900',
  RUN_ATTEMPT: '1',
  HEAD_SHA: head,
  BASE_SHA: base,
  MERGE_SHA: merge,
  RUNNER_OS_LABEL: 'ubuntu-latest',
  ...overrides,
});

function checkout(t, { source = ['one'], emitted = ['one'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'artifact-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tests/runtime'), { recursive: true });
  mkdirSync(join(root, 'dist/tests/runtime'), { recursive: true });
  for (const name of source) writeFileSync(join(root, 'tests/runtime', `${name}.test.ts`), `export const ${name.replace(/-/g, '')} = 'source';\n`);
  for (const name of emitted) writeFileSync(join(root, 'dist/tests/runtime', `${name}.test.js`), `export const ${name.replace(/-/g, '')} = 'emitted';\n`);
  return root;
}

test('identity requires positive run numbers, a real head and a plain OS label', () => {
  assert.deepEqual({ ...artifactIdentity(env()) }, { repositoryId: 1419608901, runId: 900, runAttempt: 1, head, base, merge, os: 'ubuntu-latest' });

  for (const field of ['REPOSITORY_ID', 'RUN_ID', 'RUN_ATTEMPT']) {
    for (const value of [undefined, '', '0', '-1', '1.5', 'abc', '99999999999999999']) {
      assert.throws(() => artifactIdentity(env({ [field]: value })), /positive integer/, `${field}=${value}`);
    }
  }
  for (const value of [undefined, '', head.slice(0, 39), `${head}f`, 'A'.repeat(40), '../etc']) {
    assert.throws(() => artifactIdentity(env({ HEAD_SHA: value })), /hexadecimal head/, `HEAD_SHA=${value}`);
  }
  for (const value of [undefined, 'ubuntu latest', 'UBUNTU', 'ubuntu/latest']) {
    assert.throws(() => artifactIdentity(env({ RUNNER_OS_LABEL: value })), /OS label/, `OS=${value}`);
  }
  for (const value of ['nope', base.slice(0, 39)]) {
    assert.throws(() => artifactIdentity(env({ BASE_SHA: value })), /hexadecimal base/, `BASE=${value}`);
  }
  assert.equal(artifactIdentity(env({ BASE_SHA: '', MERGE_SHA: '' })).base, undefined, 'push and dispatch provenance is optional');
});

test('the manifest covers every shipped file with a stable order and content hash', (t) => {
  const root = checkout(t, { source: ['b', 'a'], emitted: ['b', 'a'] });
  const files = manifestOf(root);
  assert.deepEqual(files.map((file) => file.path), [
    'dist/tests/runtime/a.test.js',
    'dist/tests/runtime/b.test.js',
    'tests/runtime/a.test.ts',
    'tests/runtime/b.test.ts',
  ]);
  for (const file of files) assert.match(file.sha256, /^[0-9a-f]{64}$/);
  assert.equal(new Set(files.map((file) => file.sha256)).size, 4, 'distinct content yields distinct hashes');
  assert.throws(() => manifestOf(root, ['missing']), /No artifact files found/);
});

test('a recorded identity verifies only against its own run context', (t) => {
  const root = checkout(t);
  writeIdentity({ root, env: env() });
  assert.equal(verifyIdentity({ root, env: env() }).runAttempt, 1);

  const wrong = {
    repository: { REPOSITORY_ID: '1419608902' },
    run: { RUN_ID: '901' },
    attempt: { RUN_ATTEMPT: '2' },
    head: { HEAD_SHA: 'd'.repeat(40) },
    base: { BASE_SHA: 'e'.repeat(40) },
    os: { RUNNER_OS_LABEL: 'windows-latest' },
  };
  for (const [label, override] of Object.entries(wrong)) {
    assert.throws(() => verifyIdentity({ root, env: env(override) }), /does not match this run/, label);
  }
  // A failed-jobs-only rerun has a new attempt but no current-attempt build.
  assert.throws(() => verifyIdentity({ root, env: env({ RUN_ATTEMPT: '2' }) }), /does not match this run/);
});

test('tampered, missing and orphaned artifact files are refused', (t) => {
  const root = checkout(t);
  writeIdentity({ root, env: env() });

  writeFileSync(join(root, 'dist/tests/runtime/one.test.js'), 'export const one = 2;\n');
  assert.throws(() => verifyIdentity({ root, env: env() }), /tampered: dist\/tests\/runtime\/one\.test\.js/);

  rmSync(join(root, 'dist/tests/runtime/one.test.js'));
  assert.throws(() => verifyIdentity({ root, env: env() }), /missing: dist\/tests\/runtime\/one\.test\.js/);

  writeFileSync(join(root, 'dist/tests/runtime/extra.test.js'), 'export const extra = 1;\n');
  assert.throws(() => verifyIdentity({ root, env: env() }), /orphan: dist\/tests\/runtime\/extra\.test\.js/);

  rmSync(join(root, IDENTITY_FILE));
  assert.throws(() => verifyIdentity({ root, env: env() }), /missing or unreadable/);

  writeFileSync(join(root, IDENTITY_FILE), '{"schemaVersion":2,"identity":{},"files":[]}');
  assert.throws(() => verifyIdentity({ root, env: env() }), /unsupported shape/);

  writeFileSync(join(root, IDENTITY_FILE), JSON.stringify({ schemaVersion: 1, identity: artifactIdentity(env()), files: [{ path: 'tests/runtime/one.test.ts', sha256: 'x' }, { path: 'tests/runtime/one.test.ts', sha256: 'y' }] }));
  assert.throws(() => verifyIdentity({ root, env: env() }), /duplicate path/);
});

test('an artifact from another OS or a merge checkout never satisfies the lane', (t) => {
  const root = checkout(t);
  writeIdentity({ root, env: env({ RUNNER_OS_LABEL: 'windows-latest' }) });
  assert.throws(() => verifyIdentity({ root, env: env() }), /does not match this run/, 'wrong OS');
  assert.throws(() => verifyIdentity({ root, env: env({ HEAD_SHA: merge }) }), /does not match this run/, 'the generated merge SHA is not H');
});

test('arguments are validated before any filesystem effect', () => {
  assert.deepEqual(parseArtifactArgs(['write']), { command: 'write', dir: process.cwd() });
  assert.deepEqual(parseArtifactArgs(['verify', '--dir', 'artifacts']), { command: 'verify', dir: 'artifacts' });
  for (const argv of [[], ['bogus'], ['write', 'extra'], ['verify', '--root', 'x'], ['verify', '--dir'], ['write', '--dir', 'a b', 'c']]) {
    assert.throws(() => parseArtifactArgs(argv), /Usage/, JSON.stringify(argv));
  }
});
