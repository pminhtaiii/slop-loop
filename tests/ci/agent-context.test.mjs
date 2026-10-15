import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliSource = resolve(repositoryRoot, 'scripts/ci/agent-context.mjs');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-context path with spaces-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cliPath = join(root, 'scripts', 'ci', 'agent-context.mjs');
  const tasksPath = join(root, 'specs', 'feature', 'tasks.md');
  const planPath = join(root, 'specs', 'feature', 'plan.md');
  const tasks = `# Tasks

## Phase 1: Setup
- [X] T001 Completed setup.

## Phase 2: US1 work
- [ ] T002 Candidate with no completion authority.
- [ ] T006 [US1] Add fulfillment recovery schema and migration in apps/api/prisma/schema.prisma and apps/api/prisma/migrations/20261007000000_fulfillment_recovery/migration.sql.
- [ ] T030 [US1] Preserve payment state in apps/web/app/checkout/[intentId]/payment/page.tsx.
- [ ] T017 [P] [US1] Add create/capture cases in apps/api/src/payment-fulfillment/payment-fulfillment.saga.spec.ts.
- [ ] T018 [US1] A different task in another file.
- [ ] T021 [US1] Define gateway contracts in apps/api/src/payment-fulfillment/ports/payment-gateway.port.ts and apps/api/src/payment-fulfillment/ports/fulfillment-gateway.port.ts.

Independent US1 test: unresolved provider outcomes remain pending until observed.

\`\`\`markdown
- [ ] T099 This fenced sample is not a canonical task.
\`\`\`

## Dependency Graph
US1 T017-T032 follows foundation.
[P] marks separate files without unmet prerequisites; it never authorizes simultaneous edits of the same file.
`;
  const plan = `# Plan

## Unrelated section
Do not include this material in task context.

## Target Structure
- apps/api/src/payment-fulfillment/{ports/payment-gateway.port.ts,ports/fulfillment-gateway.port.ts,payment-fulfillment.saga.ts}
- apps/api/src/payment-fulfillment/unrelated.service.ts

## Shared contracts
The API workflow depends only on PAYMENT_GATEWAY_PORT and FULFILLMENT_GATEWAY_PORT.
OTHER_PORT is unrelated to the selected task.

## Feature 030 database artifacts
- apps/api/prisma/schema.prisma
- apps/api/prisma/migrations/20261007000000_fulfillment_recovery/migration.sql
- apps/api/prisma/migrations/other_feature/001_seed_data.sql
This unrelated database note should not be copied into task context.

## Checkout payment route
- apps/web/app/checkout/[intentId]/payment/page.tsx
- apps/web/app/checkout/[otherId]/payment/page.tsx
`;
  await mkdir(dirname(cliPath), { recursive: true });
  await mkdir(dirname(tasksPath), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await copyFile(cliSource, cliPath);
  await writeFile(tasksPath, tasks, 'utf8');
  await writeFile(planPath, plan, 'utf8');
  await writeFile(join(root, 'src', 'declared file.ts'), 'export const value = 1;\n', 'utf8');
  await writeFile(join(root, 'docs', 'spec.md'), '# Source\n', 'utf8');
  await writeFile(join(root, 'private.env'), 'secret=fixture-only\n', 'utf8');
  await writeFile(join(root, 'untracked.txt'), 'not declared\n', 'utf8');
  await mkdir(join(root, 'context'), { recursive: true });
  await writeFile(
    join(root, 'context', 'active-feature.md'),
    [
      '# Active Feature',
      '## Current checkpoint',
      'Stale summary says T001 is open; task checkboxes are authoritative for counts.',
      'See [verification record](../specs/feature/verification.md).',
      '## Older entry',
      'See [old record](../old.md).',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(root, 'context', 'workflow.md'),
    [
      '# Workflow',
      '## Step 2: Converge',
      '## Step 3: Dual-Axis Code Review',
      '## Step 4: PR / CI Verification & Convergence',
    ].join('\n'),
    'utf8',
  );
  await writeFile(join(root, 'context', 'testing.md'), '# Verification gates\n', 'utf8');
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Agent Context Tests']);
  git(root, ['config', 'user.email', 'agent-context@example.invalid']);
  git(root, ['checkout', '-b', 'fixture']);
  git(root, [
    'add',
    '--',
    'scripts/ci/agent-context.mjs',
    'specs/feature/tasks.md',
    'specs/feature/plan.md',
    'src/declared file.ts',
    'docs/spec.md',
    'context/active-feature.md',
    'context/workflow.md',
    'context/testing.md',
  ]);
  git(root, ['commit', '-m', 'fixture baseline']);
  return { root, cliPath, tasksPath, planPath };
}

function run(fixtureValue, args, cwd = tmpdir()) {
  return spawnSync(process.execPath, [fixtureValue.cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('handoff derives canonical counts and workflow pointers from source docs', async (t) => {
  const current = await fixture(t);
  const result = run(current, ['handoff', '--tasks', 'specs/feature/tasks.md']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Canonical tasks: 1 checked; 6 open; 7 total/);
  assert.match(result.stdout, /First unchecked candidate \(not authorization\): - \[ \] T002/);
  assert.match(result.stdout, /specs\/feature\/verification\.md/);
  assert.match(result.stdout, /Step 2: Converge -> Step 3: Dual-Axis Code Review -> Step 4:/);
  assert.doesNotMatch(result.stdout, /T099/);
  assert.doesNotMatch(result.stdout, /Stale summary says/);
});

test('explicit root works when the CLI is dispatched from another checkout', async (t) => {
  const current = await fixture(t);
  const result = spawnSync(
    process.execPath,
    [cliSource, 'handoff', '--tasks', 'specs/feature/tasks.md', '--root', current.root],
    { cwd: tmpdir(), encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`Checkout: ${current.root}`));
});

test('task context is limited to the requested task, its phase notes, matching plan lines, and referenced ports', async (t) => {
  const current = await fixture(t);
  const selected = run(current, [
    'task',
    '--tasks',
    'specs/feature/tasks.md',
    '--task',
    'T017',
    '--plan',
    'specs/feature/plan.md',
  ]);
  assert.equal(selected.status, 0, selected.stderr);
  assert.match(selected.stdout, /Phase: ## Phase 2: US1 work/);
  assert.match(selected.stdout, /Canonical task line:\n- \[ \] T017 \[P\] \[US1\]/);
  assert.match(
    selected.stdout,
    /Independent US1 test: unresolved provider outcomes remain pending/,
  );
  assert.match(selected.stdout, /US1 T017-T032 follows foundation/);
  assert.match(selected.stdout, /payment-fulfillment\.saga\.ts/);
  assert.doesNotMatch(selected.stdout, /A different task in another file/);
  assert.doesNotMatch(selected.stdout, /Do not include this material/);
  assert.doesNotMatch(selected.stdout, /unrelated\.service\.ts/);

  const database = run(current, [
    'task',
    '--tasks',
    'specs/feature/tasks.md',
    '--task',
    'T006',
    '--plan',
    'specs/feature/plan.md',
  ]);
  assert.equal(database.status, 0, database.stderr);
  assert.match(database.stdout, /schema\.prisma/);
  assert.match(database.stdout, /20261007000000_fulfillment_recovery\/migration\.sql/);
  assert.doesNotMatch(database.stdout, /001_seed_data\.sql/);
  assert.doesNotMatch(database.stdout, /unrelated database note/);

  const checkout = run(current, [
    'task',
    '--tasks',
    'specs/feature/tasks.md',
    '--task',
    'T030',
    '--plan',
    'specs/feature/plan.md',
  ]);
  assert.equal(checkout.status, 0, checkout.stderr);
  assert.match(checkout.stdout, /checkout\/\[intentId\]\/payment\/page\.tsx/);
  assert.doesNotMatch(checkout.stdout, /\[otherId\]/);

  const ports = run(current, [
    'task',
    '--tasks',
    'specs/feature/tasks.md',
    '--task',
    'T021',
    '--plan',
    'specs/feature/plan.md',
  ]);
  assert.equal(ports.status, 0, ports.stderr);
  assert.match(ports.stdout, /PAYMENT_GATEWAY_PORT/);
  assert.match(ports.stdout, /FULFILLMENT_GATEWAY_PORT/);
  assert.doesNotMatch(ports.stdout, /OTHER_PORT/);
});

test('task IDs must be canonical and present, and duplicate canonical IDs fail', async (t) => {
  const current = await fixture(t);
  const invalid = run(current, ['task', '--tasks', 'specs/feature/tasks.md', '--task', 'T17']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Invalid task ID T17/);
  const unknown = run(current, ['task', '--tasks', 'specs/feature/tasks.md', '--task', 'T999']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown task ID T999/);
  assert.match(unknown.stderr, /Canonical IDs: T001, T002, T006, T030, T017, T018, T021/);
  const unknownOption = run(current, [
    'handoff',
    '--tasks',
    'specs/feature/tasks.md',
    '--surprise',
  ]);
  assert.equal(unknownOption.status, 1);
  assert.match(unknownOption.stderr, /Unknown option or positional argument: --surprise/);

  await writeFile(current.tasksPath, '# Tasks\n- [ ] T017 first\n- [x] T017 duplicate\n', 'utf8');
  const duplicate = run(current, ['handoff', '--tasks', 'specs/feature/tasks.md']);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /Duplicate canonical task ID T017/);
});

test('snapshot hashes only declared files and verifies unchanged files across unrelated HEAD drift', async (t) => {
  const current = await fixture(t);
  const created = run(current, ['snapshot', '--files', 'src/declared file.ts', 'docs/spec.md']);
  assert.equal(created.status, 0, created.stderr);
  const snapshot = JSON.parse(created.stdout);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.root, current.root);
  assert.equal(snapshot.branch, 'fixture');
  assert.equal(snapshot.files.length, 2);
  assert.deepEqual(
    snapshot.files.map((entry) => entry.path),
    ['src/declared file.ts', 'docs/spec.md'],
  );
  assert.equal(created.stdout.includes('private.env'), false);
  assert.equal(created.stdout.includes('untracked.txt'), false);
  const snapshotPath = join(current.root, 'snapshot.json');
  await writeFile(snapshotPath, `\uFEFF${JSON.stringify(snapshot, null, 2)}`, 'utf8');

  await writeFile(join(current.root, 'unrelated.txt'), 'unrelated commit\n', 'utf8');
  git(current.root, ['add', '--', 'unrelated.txt']);
  git(current.root, ['commit', '-m', 'unrelated change']);
  const verified = run(current, ['verify', '--snapshot', 'snapshot.json']);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /HEAD drift:/);
  assert.match(verified.stdout, /2\/2 unchanged/);

  await writeFile(
    join(current.root, 'src', 'declared file.ts'),
    'export const value = 2;\n',
    'utf8',
  );
  const stale = run(current, ['verify', '--snapshot', 'snapshot.json']);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /Changed: src\/declared file\.ts/);
  assert.match(stale.stderr, /Snapshot is stale/);
});

test('verify rejects missing files, malformed snapshots, workspace mismatch, and escaping paths', async (t) => {
  const current = await fixture(t);
  const created = run(current, ['snapshot', '--files', 'docs/spec.md']);
  assert.equal(created.status, 0, created.stderr);
  const snapshot = JSON.parse(created.stdout);
  const snapshotPath = join(current.root, 'snapshot.json');

  await writeFile(snapshotPath, '{', 'utf8');
  const malformed = run(current, ['verify', '--snapshot', 'snapshot.json']);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /Invalid snapshot JSON/);

  snapshot.files[0].path = 'missing.md';
  await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf8');
  const missing = run(current, ['verify', '--snapshot', 'snapshot.json']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing: missing\.md/);

  snapshot.files[0].path = '../outside.md';
  await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf8');
  const escaping = run(current, ['verify', '--snapshot', 'snapshot.json']);
  assert.equal(escaping.status, 1);
  assert.match(escaping.stderr, /escapes the checkout root/);

  snapshot.files[0].path = 'docs/spec.md';
  snapshot.root = join(current.root, 'another-checkout');
  await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf8');
  const mismatch = run(current, ['verify', '--snapshot', 'snapshot.json']);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /Snapshot workspace mismatch/);
});
