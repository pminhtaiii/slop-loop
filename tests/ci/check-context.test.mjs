import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  await writeFile(
    join(root, 'context/contract.json'),
    JSON.stringify({
      requiredDocuments: ['context/README.md'],
      facts: {},
      authorizationReferences: [],
    }),
  );
  await writeFile(join(root, 'AGENTS.md'), '[Context](context/README.md)\n');
  return root;
}

function check(root) {
  return spawnSync(process.execPath, [cli, '--root', root], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
}

async function skillFixture(t, workflow) {
  const root = await fixture(t);
  await mkdir(join(root, '.agents/skills/verify-task'), { recursive: true });
  await writeFile(join(root, '.agents/skills/verify-task/SKILL.md'), '# Verify task\n');
  await writeFile(join(root, 'context/README.md'), '[Workflow](workflow.md)\n');
  await writeFile(join(root, 'context/workflow.md'), workflow);
  await writeFile(
    join(root, 'context/contract.json'),
    JSON.stringify({
      requiredDocuments: ['context/README.md'],
      facts: {},
      authorizationReferences: [],
      requiredSkillStages: [
        {
          skill: 'verify-task',
          stage: 'Task briefs and handoffs',
          path: '.agents/skills/verify-task/SKILL.md',
        },
      ],
    }),
  );
  return root;
}

test('required skill wiring must appear in the declared workflow stage', async t => {
  const root = await skillFixture(t, ['# Workflow', '### Task briefs and handoffs', 'No skill link is declared here.', ''].join('\n'));
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /context\/workflow\.md.*verify-task.*Task briefs and handoffs/);
});

test('a required skill link in another workflow stage does not satisfy the mapping', async t => {
  const root = await skillFixture(
    t,
    ['# Workflow', '### Before editing', '[verify-task](../.agents/skills/verify-task/SKILL.md)', '### Task briefs and handoffs', 'The skill is not linked in this stage.', ''].join('\n'),
  );
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /required skill verify-task must link .* within stage Task briefs and handoffs/);
});

test('fenced workflow examples cannot supply the required stage or skill link', async t => {
  for (const workflow of [
    ['# Workflow', '### Task briefs and handoffs', '```markdown', '[verify-task](../.agents/skills/verify-task/SKILL.md)', '```'].join('\n'),
    ['# Workflow', '```markdown', '### Task briefs and handoffs', '[verify-task](../.agents/skills/verify-task/SKILL.md)', '```'].join('\n'),
  ]) {
    const root = await skillFixture(t, workflow);
    const result = check(root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /context\/workflow\.md.*verify-task/);
  }
});

test('skill links in nested workflow sections count only before the next peer stage', async t => {
  const nested = await skillFixture(
    t,
    ['# Workflow', '### Task briefs and handoffs', '#### Worker handoff', '[verify-task](../.agents/skills/verify-task/SKILL.md)', '### Publication', ''].join('\n'),
  );
  assert.equal(check(nested).status, 0);

  const afterBoundary = await skillFixture(
    t,
    ['# Workflow', '### Task briefs and handoffs', 'The skill is not linked in this stage.', '### Publication', '[verify-task](../.agents/skills/verify-task/SKILL.md)', ''].join('\n'),
  );
  const result = check(afterBoundary);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /required skill verify-task must link .* within stage Task briefs and handoffs/);
});

test('missing required skill files fail even when their workflow link is present', async t => {
  const root = await skillFixture(t, ['# Workflow', '### Task briefs and handoffs', '[verify-task](../.agents/skills/verify-task/SKILL.md)', ''].join('\n'));
  await rm(join(root, '.agents/skills/verify-task/SKILL.md'));
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /SKILL\.md.*ENOENT/);
});

test('malformed required skill mappings fail instead of being skipped', async t => {
  const root = await skillFixture(t, '# Workflow\n### Task briefs and handoffs\n');
  const contractPath = join(root, 'context/contract.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  contract.requiredSkillStages[0].path = '';
  await writeFile(contractPath, JSON.stringify(contract));
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /each required skill stage requires a skill, stage, and path/);
});

test('skill links and stage headings inside HTML comments do not satisfy the stage mapping', async t => {
  const commented = await skillFixture(t, ['# Workflow', '### Task briefs and handoffs', '<!--', '[verify-task](../.agents/skills/verify-task/SKILL.md)', '-->', ''].join('\n'));
  const commentedResult = check(commented);
  assert.equal(commentedResult.status, 1, commentedResult.stderr);
  assert.match(commentedResult.stderr, /context\/workflow\.md.*verify-task.*Task briefs and handoffs/);

  const visible = await skillFixture(t, ['# Workflow', '### Task briefs and handoffs', '[verify-task](../.agents/skills/verify-task/SKILL.md)', ''].join('\n'));
  assert.equal(check(visible).status, 0);

  const commentedStage = await skillFixture(
    t,
    ['# Workflow', '<!--', '### Task briefs and handoffs', '-->', '### Publication', '[verify-task](../.agents/skills/verify-task/SKILL.md)', ''].join('\n'),
  );
  const stageResult = check(commentedStage);
  assert.equal(stageResult.status, 1, stageResult.stderr);
  assert.match(stageResult.stderr, /Task briefs and handoffs must have one matching heading/);
});

test('HTML comment masking preserves reported link line numbers', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'context/README.md'), ['# Routing', '<!--', '[Hidden](missing-hidden.md)', '-->', '[Visible](missing.md)'].join('\n'));
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stderr, /missing-hidden/);
  assert.match(result.stderr, /context\/README\.md:5: missing\.md/);
});

test('code fences and HTML comments do not mask one another', async t => {
  for (const readme of [['# Routing', '<!--', '```md', '-->', '[Visible](missing.md)'].join('\n'), ['# Routing', '```md', '<!--', '```', '[Visible](missing.md)'].join('\n')]) {
    const root = await fixture(t);
    await writeFile(join(root, 'context/README.md'), readme);
    const result = check(root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /context\/README\.md:5: missing\.md/);
  }
});

test('an unterminated HTML comment masks to the end without throwing', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'context/README.md'), '# Routing\n<!-- note\n[Visible](missing.md)\n');
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
});

test('valid context links pass without fetching external links', async t => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'context/README.md'),
    [
      '[Policy](policy.md#limits)',
      '[Criteria](../docs/progress-checker-matrices.md)',
      '[Spaced path](<policy notes.md>)',
      '[Encoded path](policy%20notes.md)',
      '[External](https://invalid.example/unreachable)',
      '[Section](#routing)',
    ].join('\n'),
  );
  await writeFile(join(root, 'context/policy.md'), '# Limits\n');
  await writeFile(join(root, 'context/policy notes.md'), '# Notes\n');
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
});

test('required documents cannot silently disappear from the context contract', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'context/README.md'), '# Context\n');
  await writeFile(
    join(root, 'context/contract.json'),
    JSON.stringify({
      requiredDocuments: ['context/README.md', 'context/policy.md'],
      facts: {},
      authorizationReferences: [],
    }),
  );
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /required document missing: context\/policy\.md/);
});

test('missing local targets fail with their source file and line', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'context/README.md'), '# Routing\n[Policy](missing.md)\n');
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /context\/README\.md:2: missing\.md/);
});

test('linked agent documents are checked transitively with cycles visited once', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'context/README.md'), '[Delegation](../docs/delegation.md)\n');
  await writeFile(join(root, 'docs/delegation.md'), '[Guide](guide.md)\n');
  await writeFile(join(root, 'docs/guide.md'), '[Back](delegation.md)\n[Context](../context/README.md)\n');
  assert.equal(check(root).status, 0);
  await writeFile(join(root, 'docs/guide.md'), '# Guide\n[Missing](missing.md)\n');
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /docs\/guide\.md:2: missing\.md/);
});

test('linked documents retain code-example masking and checkout containment', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await writeFile(join(root, 'context/README.md'), '[Guide](../docs/guide.md)\n');
  await writeFile(join(root, 'docs/guide.md'), '```md\n[Example](absent.md)\n```\n`[Example](also-absent.md)`\n');
  assert.equal(check(root).status, 0);
  const target = relative(join(root, 'docs'), join(outside, 'AGENTS.md')).split('\\').join('/');
  await writeFile(join(root, 'docs/guide.md'), `[Escape](${target})\n`);
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /docs\/guide\.md:1: .*target is outside the checkout/);
});

test('example links inside fenced and inline code do not fail the check', async t => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'context/README.md'),
    ['```markdown', '[Example](missing-example.md)', '```', '~~~markdown', '[Another example](missing-tilde.md)', '~~~', '`[Inline example](missing-inline.md)`'].join('\n'),
  );
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
});

test('existing files outside the checkout are rejected as context targets', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const target = relative(join(root, 'context'), join(outside, 'AGENTS.md')).split('\\').join('/');
  await writeFile(join(root, 'context/README.md'), `[Outside](${target})\n`);
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /target is outside the checkout/);
});

test('new context documents need a route from the context README', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'context/README.md'), '# Context\n');
  await writeFile(join(root, 'context/unrouted.md'), '# Forgotten policy\n');
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /context\/unrouted\.md is not routed from context\/README\.md/);
});

async function stackFixture(t, claim, choice = 'TypeScript') {
  const root = await fixture(t);
  await writeFile(
    join(root, 'context/contract.json'),
    JSON.stringify({
      requiredDocuments: ['context/README.md', 'context/tech_stack.md'],
      facts: { 'runtime-language': { source: 'context/tech_stack.md', tableRow: 'Implementation' } },
      authorizationReferences: [],
    }),
  );
  await writeFile(join(root, 'context/tech_stack.md'), `# Stack\n| Area | Choice | Scope |\n|---|---|---|\n| Implementation | ${choice} | Runtime |\n`);
  await writeFile(join(root, 'context/README.md'), `# Context\n[Stack](tech_stack.md)\n${claim}\n`);
  return root;
}

test('marked facts match their source table without duplicating values in the contract', async t => {
  const root = await stackFixture(t, '<!-- context-fact: runtime-language -->`TypeScript`<!-- /context-fact -->');
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 canonical facts/);
});

test('a source stack change exposes a stale repeated claim', async t => {
  const root = await stackFixture(t, '<!-- context-fact: runtime-language -->TypeScript<!-- /context-fact -->', 'Rust');
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /context\/README\.md:3: fact runtime-language conflicts with context\/tech_stack\.md: expected Rust/);
});

test('unknown or incomplete fact markers fail rather than silently bypass checks', async t => {
  for (const [claim, message] of [
    ['<!-- context-fact: typo -->TypeScript<!-- /context-fact -->', /unknown fact typo/],
    ['<!-- context-fact: runtime-language -->TypeScript', /malformed context-fact markers/],
  ]) {
    const root = await stackFixture(t, claim);
    const result = check(root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
  }
});

test('agent instructions must expose the context entry point', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'context/README.md'), '# Context\n');
  await writeFile(join(root, 'AGENTS.md'), '# No route\n');
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /AGENTS\.md must route to context\/README\.md/);
});

test('authorization summaries point to the configured source without deriving permission from task status', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'docs/uc03'));
  await writeFile(join(root, 'context/README.md'), '# Context\n');
  await writeFile(join(root, 'docs/uc03/decisions.md'), '# Recorded decisions\n');
  await writeFile(join(root, 'docs/uc03/tasks.md'), '- [x] T005 completed\n[Decisions](decisions.md)\n');
  await writeFile(join(root, 'AGENTS.md'), ['[Context](context/README.md)', '[UC-03 decisions](docs/uc03/decisions.md)', '[UC-03 status](docs/uc03/tasks.md)'].join('\n'));
  await writeFile(
    join(root, 'context/contract.json'),
    JSON.stringify({
      requiredDocuments: ['context/README.md'],
      facts: {},
      authorizationReferences: [{ id: 'uc03', source: 'docs/uc03/decisions.md', summaries: ['AGENTS.md', 'docs/uc03/tasks.md'] }],
    }),
  );
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Context checks passed/);
  assert.doesNotMatch(result.stdout, /authorization|authorized|permission|grant/i);
});

test('authorization summaries fail when they point to a different recorded source', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'docs/uc03'));
  await writeFile(join(root, 'context/README.md'), '# Context\n');
  await writeFile(join(root, 'docs/uc03/decisions.md'), '# Earlier record\n');
  await writeFile(join(root, 'docs/uc03/decisions-current.md'), '# Current record\n');
  await writeFile(join(root, 'docs/uc03/spec.md'), '[Decisions](decisions.md)\n');
  await writeFile(join(root, 'AGENTS.md'), ['[Context](context/README.md)', '[UC-03 decisions](docs/uc03/decisions-current.md)', '[UC-03 spec](docs/uc03/spec.md)'].join('\n'));
  await writeFile(
    join(root, 'context/contract.json'),
    JSON.stringify({
      requiredDocuments: ['context/README.md'],
      facts: {},
      authorizationReferences: [{ id: 'uc03', source: 'docs/uc03/decisions-current.md', summaries: ['AGENTS.md', 'docs/uc03/spec.md'] }],
    }),
  );
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /docs\/uc03\/spec\.md: must link to authorization source docs\/uc03\/decisions-current\.md/);
});

test('authorization source duplication is reported instead of creating a second authority entry', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'docs/uc03'));
  await writeFile(join(root, 'context/README.md'), '# Context\n');
  await writeFile(join(root, 'docs/uc03/decisions.md'), '# Recorded decisions\n');
  await writeFile(join(root, 'AGENTS.md'), '[Context](context/README.md)\n[Decisions](docs/uc03/decisions.md)\n');
  await writeFile(
    join(root, 'context/contract.json'),
    JSON.stringify({
      requiredDocuments: ['context/README.md'],
      facts: {},
      authorizationReferences: [
        { id: 'uc03', source: 'docs/uc03/decisions.md', summaries: ['AGENTS.md'] },
        { id: 'uc03-duplicate', source: 'docs/uc03/decisions.md', summaries: ['AGENTS.md'] },
      ],
    }),
  );
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /authorization source is referenced more than once: docs\/uc03\/decisions\.md/);
});

test('duplicate source rows cannot give a fact two authoritative values', async t => {
  const root = await stackFixture(t, '<!-- context-fact: runtime-language -->TypeScript<!-- /context-fact -->');
  await writeFile(join(root, 'context/tech_stack.md'), '| Implementation | TypeScript |\n| Implementation | Rust |\n');
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /fact runtime-language needs one source row Implementation/);
});
