import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNewDescription, assertPrMetadata, historicalBinding } from '../../scripts/agents/pr-conventions.mjs';
import { checkPrMetadata, eventMetadata } from '../../scripts/ci/check-pr-metadata.mjs';
import { parseHistoricalBindings } from '../../scripts/ci/required-checks.mjs';

const source = new URL('../../scripts/ci/check-pr-metadata.mjs', import.meta.url);
const branch = 'feat/tooling-pr-metadata';
const BODY = '## Summary\n\nStandardize the metadata check.\n\n## Evidence\n\nBefore: none; after: focused tests.\n\n## Merge Danger\n\n**Door:** revert the commit.\n\n**Blast Radius:** contributor tooling only.';
const CR_START = '<!-- This is an auto-generated comment: release notes by coderabbit.ai -->';
const CR_END = '<!-- end of auto-generated comment: release notes by coderabbit.ai -->';
const CR_BLOCK = `${CR_START}\n\n<!-- coderabbit-ai-generated:v1 -->\n\n## Summary by CodeRabbit\n\nThe change standardizes the metadata check.\n\n${CR_END}`;
const metadata = (overrides = {}) => ({ branch, base: 'development', title: `${branch}: add the metadata check`, body: BODY, ...overrides });
const refusal = (run) => {
  try { run(); } catch (error) { return error.message; }
  assert.fail('expected a refusal');
};
const repositoryId = 1419608901, head = 'a'.repeat(40), tree = 'b'.repeat(40);
const bindings = (entries = [{ repositoryId, number: 42, head, headRepositoryId: repositoryId, tree, policy: 'ci-v1', convention: 1 }]) =>
  parseHistoricalBindings(JSON.stringify({ schemaVersion: 1, entries }));
const event = (overrides = {}) => ({
  action: 'edited',
  repository: { id: repositoryId },
  pull_request: {
    number: 42, draft: false, title: `${branch}: add the metadata check`, body: BODY, ...overrides,
    base: { ref: 'development', ...overrides.base }, head: { ref: branch, sha: head, repo: { id: repositoryId }, ...overrides.head },
  },
});

test('canonical metadata passes under each explicit convention', () => {
  assert.doesNotThrow(() => assertPrMetadata(metadata(), { convention: 2 }));
  assert.doesNotThrow(() => assertPrMetadata(metadata({ branch: 'feat/042-tooling-metadata', title: 'feat/042-tooling-metadata: add the metadata check' }), { convention: 1 }));
  const retained = metadata({ branch: 'feat/001-example', title: 'feat/001-example: historical title', body: 'Historical unstructured description' });
  assert.doesNotThrow(() => assertPrMetadata(retained), 'retained identities stay readable without a convention');
  assert.doesNotThrow(() => assertPrMetadata({ ...retained, body: undefined }), 'a retained live read need not carry a body');
});

test('wrong or missing field types are refused by field and rule without echoing the value', () => {
  const cases = [
    [null, /metadata/],
    [[], /metadata/],
    ['text', /metadata/],
    [metadata({ branch: 42 }), /branch/],
    [metadata({ branch: undefined }), /branch/],
    [metadata({ base: {} }), /base/],
    [metadata({ base: undefined }), /base/],
    [metadata({ title: ['feat/x: add'] }), /title/],
    [metadata({ body: 42 }), /body/],
    [metadata({ body: undefined }), /body/],
  ];
  for (const [value, pattern] of cases) {
    const message = refusal(() => assertPrMetadata(value, { convention: 2 }));
    assert.match(message, pattern);
    assert.doesNotMatch(message, /42|\bfeat\/|Standardize|Blast Radius/, message);
  }
  assert.match(refusal(() => assertPrMetadata(metadata(), { convention: '2' })), /convention/);
  assert.match(refusal(() => assertPrMetadata(metadata(), { convention: 3 })), /convention/);
});

test('a non-development base is refused before any other metadata rule', () => {
  assert.match(refusal(() => assertPrMetadata(metadata({ base: 'main' }), { convention: 2 })), /base must be development/);
});

test('canonical branch, title and body failures are refused', () => {
  const failures = [
    [metadata({ branch: 'feat/042-tooling-metadata', title: 'feat/042-tooling-metadata: add the metadata check' }), 2, /branch/],
    [metadata({ branch: 'tooling-metadata', title: 'tooling-metadata: add the metadata check' }), 2, /branch/],
    [metadata({ title: 'feat/001-other: add the metadata check' }), 2, /title/],
    [metadata({ title: `${branch}: ` }), 2, /title/],
    [metadata({ title: `${branch}: ${'x'.repeat(81)}` }), 2, /title/],
    [metadata({ title: `${branch}: tooling changes` }), 2, /title/],
    [metadata({ title: `${branch}: add two\nlines` }), 2, /title/],
    [metadata({ title: 'add the metadata check' }), 2, /title/],
    [metadata({ body: 'plain text' }), 2, /body/],
    [metadata({ body: '## Evidence\n\nchecks\n\n## Summary\n\nchange\n\n## Merge Danger\n\n**Door:** revert.\n\n**Blast Radius:** tooling.' }), 2, /body/],
    [metadata({ body: '## Summary\n\n## Evidence\n\nchecks\n\n## Merge Danger\n\n**Door:** revert.\n\n**Blast Radius:** tooling.' }), 2, /body/],
    [metadata({ body: '## Summary\n\nchange\n\n## Evidence\n\nchecks\n\n## Merge Danger\n\n**Blast Radius:** tooling.' }), 2, /body/],
    [metadata({ body: '## Summary\n\nchange\n\n## Evidence\n\nchecks\n\n## Merge Danger\n\n**Door:** revert.' }), 2, /body/],
    [metadata({ body: '## Summary\n\nchange\n\n## Evidence\n\nchecks\n\n## Merge Danger\n\n```\n**Door:** revert.\n**Blast Radius:** tooling.\n```\n' }), 2, /body/],
  ];
  for (const [value, convention, pattern] of failures) assert.match(refusal(() => assertPrMetadata(value, { convention })), pattern, value.title);
  // Version 1 keeps numbered branches and the same title/body rules.
  const numbered = { branch: 'feat/042-tooling-metadata', base: 'development', title: 'feat/042-tooling-metadata: add the metadata check', body: 'plain text' };
  assert.match(refusal(() => assertPrMetadata(numbered, { convention: 1 })), /body/);
});

test('the CodeRabbit auto-generated tail is dropped before section analysis', () => {
  assert.doesNotThrow(() => assertPrMetadata(metadata({ body: `${BODY}\n\n${CR_BLOCK}` }), { convention: 2 }));
  assert.doesNotThrow(() => assertNewDescription(`${BODY}\n\n${CR_BLOCK}`), 'the pure description path accepts the tail too');
  // Only the block is dropped: a mid-body block leaves the canonical sections after it.
  assert.doesNotThrow(() => assertPrMetadata(metadata({ body: `${CR_BLOCK}\n\n${BODY}` }), { convention: 2 }));
});

test('generated-block and remaining section rules still refuse', () => {
  assert.match(refusal(() => assertPrMetadata(metadata({ body: CR_BLOCK }), { convention: 2 })), /body/);
  // An unclosed start marker runs to the end of the body, so headings inside it are never real
  // sections and a fake duplicate '## Summary' behind the marker cannot stand in for one.
  const unclosed = `Just prose, no sections.\n\n${CR_START}\n\n## Summary\n\nfake\n\n## Evidence\n\nfake\n\n## Merge Danger\n\n**Door:** revert.\n\n**Blast Radius:** tooling.\n\n## Summary\n\nfake duplicate`;
  assert.match(refusal(() => assertPrMetadata(metadata({ body: unclosed }), { convention: 2 })), /body/);
  const fenced = `${BODY}\n\n\`\`\`\n${CR_START}\n## Summary\nreordered\n${CR_END}\n\`\`\``;
  assert.doesNotThrow(() => assertPrMetadata(metadata({ body: fenced }), { convention: 2 }), 'a fenced copy is literal content, not a real tail');
  const fourth = `${BODY}\n\n## Notes\n\nextra section`;
  assert.match(refusal(() => assertPrMetadata(metadata({ body: fourth }), { convention: 2 })), /body/);
});

test('no refusal echoes the submitted title or body text', () => {
  const marker = 'SECRET-BODY-MARKER-9f2c';
  const message = refusal(() => assertPrMetadata(metadata({ title: `${branch}: ${marker}`, body: `## Summary\n\n${marker}\n` }), { convention: 2 }));
  assert.doesNotMatch(message, new RegExp(marker));
  assert.doesNotMatch(message, /feat\/tooling-pr-metadata/);
});

test('historical convention identity is selected only by an explicit binding', () => {
  const bound = event({ head: { ref: 'feat/042-tooling-metadata' }, title: 'feat/042-tooling-metadata: add the metadata check' });
  assert.equal(checkPrMetadata(bound, { bindings: bindings() }).status, 'PASSED');
  assert.match(refusal(() => checkPrMetadata(bound, { bindings: [] })), /branch/, 'current conventions apply without a binding');
  assert.match(refusal(() => checkPrMetadata(event({ number: 43, head: { ref: 'feat/042-tooling-metadata' }, title: 'feat/042-tooling-metadata: add the metadata check' }), { bindings: bindings() })), /branch/);

  const forged = event({ head: { ref: 'feat/042-tooling-metadata' }, title: 'feat/042-tooling-metadata: add the metadata check', convention: 1, conventionVersion: 1 });
  assert.match(refusal(() => checkPrMetadata(forged, { bindings: [] })), /branch/, 'a PR cannot name its own convention');
  assert.equal(historicalBinding({ repositoryId, number: 42, head, headRepositoryId: repositoryId }, bindings()).convention, 1);
  assert.equal(historicalBinding({ repositoryId, number: 42, head }, bindings()), undefined, 'partial identities never match a binding');
  // A bound identity whose audited entry names no convention must not fall into the lenient
  // "no convention" path: that would let an incomplete binding bypass body and summary rules.
  assert.match(
    refusal(() => checkPrMetadata(event({ body: 'arbitrary unstructured body' }), { bindings: bindings([{ repositoryId, number: 42, head, headRepositoryId: repositoryId, tree, policy: 'ci-v1' }]) })),
    /body/,
    'a binding without a convention still gets the current convention'
  );
});

test('shell-like metadata is data: parsed, validated and never executed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pr-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'executed');
  const shell = `$(touch ${marker}) \`touch ${marker}\` ; touch ${marker} | touch ${marker}`;
  const payload = event({ body: `${BODY}\n\n${shell}` });
  assert.equal(eventMetadata(payload).metadata.body, payload.pull_request.body, 'event text is returned unchanged');
  assert.equal(checkPrMetadata(payload).status, 'PASSED');

  const path = join(root, 'event.json');
  await writeFile(path, JSON.stringify(payload));
  const passed = spawnSync(process.execPath, [fileURLToPath(source), path], { encoding: 'utf8', windowsHide: true });
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).status, 'PASSED');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });

  await writeFile(path, JSON.stringify(event({ body: shell, title: `${branch}: ${shell}` })));
  const refused = spawnSync(process.execPath, [fileURLToPath(source), path], { encoding: 'utf8', windowsHide: true });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /title|branch|body/);
  assert.doesNotMatch(refused.stderr, /touch/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('drafts and ready PRs are validated by the same rules', () => {
  for (const draft of [true, false]) {
    assert.equal(checkPrMetadata(event({ draft })).status, 'PASSED', String(draft));
    assert.match(refusal(() => checkPrMetadata(event({ draft, body: 'plain text' }))), /body/, String(draft));
  }
});

test('input is validated without mutation', () => {
  const value = metadata(), snapshot = JSON.stringify(value);
  assertPrMetadata(value, { convention: 2 });
  assert.equal(JSON.stringify(value), snapshot);
  const payload = event(), eventSnapshot = JSON.stringify(payload);
  checkPrMetadata(payload);
  assert.equal(JSON.stringify(payload), eventSnapshot);
});
