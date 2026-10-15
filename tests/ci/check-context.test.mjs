import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/ci/check-context.mjs');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'context-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'context'));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'AGENTS.md'), '# Instructions\n');
  await writeFile(join(root, 'docs/progress-checker-matrices.md'), '# Criteria\n');
  await writeFile(join(root, 'context/contract.json'), JSON.stringify({
    requiredDocuments: ['context/README.md'], facts: {},
  }));
  await writeFile(join(root, 'AGENTS.md'), '[Context](context/README.md)\n');
  return root;
}

function check(root) {
  return spawnSync(process.execPath, [cli, '--root', root], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
}

test('valid context links pass without fetching external links', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'context/README.md'), [
    '[Policy](policy.md#limits)',
    '[Criteria](../docs/progress-checker-matrices.md)',
    '[Spaced path](<policy notes.md>)',
    '[Encoded path](policy%20notes.md)',
    '[External](https://invalid.example/unreachable)',
    '[Section](#routing)',
  ].join('\n'));
  await writeFile(join(root, 'context/policy.md'), '# Limits\n');
  await writeFile(join(root, 'context/policy notes.md'), '# Notes\n');
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
});

test('required documents cannot silently disappear from the context contract', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'context/README.md'), '# Context\n');
  await writeFile(join(root, 'context/contract.json'), JSON.stringify({
    requiredDocuments: ['context/README.md', 'context/policy.md'], facts: {},
  }));
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /required document missing: context\/policy\.md/);
});

test('missing local targets fail with their source file and line', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'context/README.md'), '# Routing\n[Policy](missing.md)\n');
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /context\/README\.md:2: missing\.md/);
});

test('example links inside fenced and inline code do not fail the check', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'context/README.md'), [
    '```markdown', '[Example](missing-example.md)', '```',
    '~~~markdown', '[Another example](missing-tilde.md)', '~~~',
    '`[Inline example](missing-inline.md)`',
  ].join('\n'));
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
});

test('existing files outside the checkout are rejected as context targets', async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const target = relative(join(root, 'context'), join(outside, 'AGENTS.md')).split('\\').join('/');
  await writeFile(join(root, 'context/README.md'), `[Outside](${target})\n`);
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /target is outside the checkout/);
});
