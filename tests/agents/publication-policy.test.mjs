import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPublicationPolicy } from '../../scripts/agents/publication-policy.mjs';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);

function fromDiff(raw, options = {}) {
  return selectPublicationPolicy({ base, head, git: () => raw, ...options });
}

test('automatic policy selects push-only for documentation and contributor helper paths', async () => {
  const calls = [];
  const policy = await selectPublicationPolicy({
    base,
    head,
    git(...args) {
      calls.push(args);
      return 'M\0docs/guide.md\0A\0scripts/agents/helper.mjs\0';
    },
  });

  assert.equal(policy.mode, 'push-only');
  assert.equal(policy.provenance, 'automatic-v1');
  assert.equal(policy.classification, 'docs-helper-only');
  assert.match(policy.reason, /documentation and contributor helper/);
  assert.deepEqual(policy.paths, ['docs/guide.md', 'scripts/agents/helper.mjs']);
  assert.deepEqual(calls, [['diff', '--name-status', '-z', '--find-renames', base, head]]);
});

test('the automatic helper allowlist includes the declared root and tooling path families', async () => {
  for (const path of [
    'AGENTS.md',
    'README.md',
    'docs/policy.md',
    'context/workflow.md',
    '.agents/skills/review/SKILL.md',
    '.githooks/pre-commit',
    'scripts/agents/pr-workflow.mjs',
    'tests/agents/pr-workflow.test.mjs',
    'tests/ci/check-context.test.mjs',
  ]) {
    const policy = await fromDiff(`M\0${path}\0`);
    assert.equal(policy.mode, 'push-only', path);
  }
  assert.equal((await fromDiff('M\0nested/README.md\0')).mode, 'full');
  assert.equal((await fromDiff('M\0src/AGENTS.md\0')).mode, 'full');
});

test('runtime, dependency, build, GitHub, and unknown paths require full gates', async () => {
  for (const path of [
    'src/app.ts',
    'eval/case.json',
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    '.github/workflows/ci.yml',
    'vendor/helper.mjs',
    'scripts/ci/check-runtime.mjs',
    'scripts/ci/run-runtime-tests.mjs',
    'scripts/ci/test-selection.mjs',
    'scripts/ci/artifact-identity.mjs',
    'scripts/ci/unreviewed-helper.mjs',
    'scripts/ci/nested/check-context.mjs',
  ]) {
    const policy = await fromDiff(`M\0${path}\0`);
    assert.equal(policy.mode, 'full', path);
    assert.equal(policy.classification, 'full-required', path);
    assert.match(policy.reason, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('only reviewed contributor helpers under scripts/ci are eligible for skipped local gates', async () => {
  for (const path of ['scripts/ci/check-context.mjs', 'scripts/ci/check-staged-file-size.mjs', 'scripts/ci/check-env-examples.mjs', 'scripts/ci/check-tracked-files.mjs']) {
    assert.equal((await fromDiff(`M\0${path}\0`)).mode, 'push-only', path);
  }
});

test('dependency and build configuration files require full gates even in helper directories', async () => {
  for (const path of ['scripts/agents/package.json', 'tests/ci/pnpm-lock.yaml', 'scripts/agents/tsconfig.json']) {
    assert.equal((await fromDiff(`M\0${path}\0`)).mode, 'full', path);
  }
});

test('mixed documentation and runtime paths require full gates', async () => {
  const policy = await fromDiff('M\0docs/guide.md\0M\0src/app.ts\0');
  assert.equal(policy.mode, 'full');
  assert.deepEqual(policy.paths, ['docs/guide.md', 'src/app.ts']);
});

test('renames classify both old and new paths, and deletes and mode changes use their path', async () => {
  const rename = await fromDiff('R100\0src/entry.ts\0docs/entry.ts\0');
  assert.equal(rename.mode, 'full');
  assert.deepEqual(rename.paths, ['src/entry.ts', 'docs/entry.ts']);

  const deletion = await fromDiff('D\0docs/old-guide.md\0');
  assert.equal(deletion.mode, 'push-only');
  const modeChange = await fromDiff('M\0.githooks/pre-commit\0');
  assert.equal(modeChange.mode, 'push-only');

  for (const raw of ['R100\0scripts/ci/check-runtime.mjs\0scripts/ci/check-context.mjs\0', 'R100\0scripts/ci/check-context.mjs\0scripts/ci/run-runtime-tests.mjs\0']) {
    const ciRename = await fromDiff(raw);
    assert.equal(ciRename.mode, 'full');
    assert.equal(ciRename.paths.length, 2);
  }
});

test('empty, malformed, and unreadable automatic diffs fail closed', async () => {
  for (const raw of ['', 'M\0docs/guide.md', 'X\0docs/guide.md\0', 'R100\0src/entry.ts\0', 'M\0\0']) {
    await assert.rejects(fromDiff(raw));
  }
  await assert.rejects(
    selectPublicationPolicy({
      base,
      head,
      git() {
        throw new Error('range read failed');
      },
    }),
    /Could not read the exact base-to-candidate Git diff: range read failed/,
  );
});

test('explicit modes retain their own provenance and do not infer from paths', async () => {
  let called = false;
  const git = () => {
    called = true;
    return 'M\0src/app.ts\0';
  };
  const full = await selectPublicationPolicy({ requestedMode: 'full', base, head, git });
  assert.equal(full.mode, 'full');
  assert.equal(full.provenance, 'explicit-v1');
  const pushOnly = await selectPublicationPolicy({ requestedMode: 'push-only', reason: 'User requested push-only.', base, head, git });
  assert.equal(pushOnly.mode, 'push-only');
  assert.equal(pushOnly.provenance, 'explicit-v1');
  assert.equal(pushOnly.reason, 'User requested push-only.');
  assert.equal(called, false);
});
