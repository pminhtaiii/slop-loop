import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { assess, changedLines, runWorkflow, workflowSummary } from '../../scripts/agents/pr-workflow.mjs';
import { packageScriptCommand } from '../../scripts/agents/workflow-gate.mjs';
import { checkout, evidence } from './support/pr-workflow-fixture.mjs';

const git = (root, ...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

async function setCandidate(f, files) {
  git(f.root, 'reset', '--hard', 'origin/development');
  for (const [path, content] of Object.entries(files)) {
    const file = join(f.root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  git(f.root, 'add', '--', ...Object.keys(files));
  git(f.root, 'commit', '--quiet', '-m', 'candidate changes');
  const head = git(f.root, 'rev-parse', 'HEAD');
  f.e.head = head;
  f.e.pr.headRefOid = head;
  for (const check of f.e.checks) check.head_sha = head;
  return head;
}

const localGates = calls => calls.filter(([binary]) => binary === process.execPath || binary === packageScriptCommand('test:contributors').command);

async function recordReview(f, head) {
  const file = join(f.root, '.agent-work/review.json');
  const standards = join(f.root, '.agent-work/standards.md');
  const spec = join(f.root, '.agent-work/spec.md');
  await writeFile(standards, 'Standards axis: no findings.\n');
  await writeFile(spec, 'Spec axis: no findings.\n');
  await writeFile(
    file,
    JSON.stringify({
      base: git(f.root, 'rev-parse', 'origin/development'),
      head,
      axes: [
        { name: 'standards', findings: [] },
        { name: 'spec', findings: [] },
      ],
      reports: [standards, spec],
    }),
  );
  return f.run('record-review', '--receipt', file);
}

async function recordRawReview(f, receipt) {
  const file = join(f.root, '.agent-work/review.json');
  await writeFile(file, JSON.stringify(receipt));
  return f.run('record-review', '--receipt', file);
}

/** Two distinct non-empty report files, for receipts whose failure is meant to come from elsewhere. */
function reportsFor(f) {
  return [join(f.root, 'standards.md'), join(f.root, 'spec.md')];
}

test('current-head CI allows human review without CodeRabbit approval', () => {
  const e = evidence();
  assert.equal(assess(e).status, 'READY_FOR_HUMAN');
  e.pr.reviews.nodes[0].commit.oid = 'old';
  assert.equal(assess(e).status, 'READY_FOR_HUMAN');
  e.pr.reviews.nodes = [];
  assert.equal(assess(e).status, 'READY_FOR_HUMAN');
});

test('default publication skips full local gates for documentation and helper-only changes with provenance', async t => {
  const f = await checkout(t);
  await setCandidate(f, { 'docs/contributor-guide.md': '# Guide\n', 'scripts/agents/helper.mjs': 'export {};\n' });

  const published = await f.run('publish', '--body-file', f.body, '--skip-review-request');

  assert.equal(published.publicationMode, 'push-only');
  assert.equal(published.publicationProvenance, 'automatic-v1');
  assert.equal(published.publicationPolicy.classification, 'docs-helper-only');
  assert.match(published.publicationReason, /documentation and contributor helper/);
  assert.equal(published.localVerifiedHead, undefined);
  assert.equal(published.localVerification, undefined);
  assert.equal(workflowSummary(published).localGateStatus, 'skipped');
  assert.equal(workflowSummary(published).publicationPolicy.provenance, 'automatic-v1');
  assert.equal(localGates(f.calls).length, 0);
});

test('default publication keeps full local gates for runtime changes', async t => {
  const f = await checkout(t);
  const head = await setCandidate(f, { 'src/app.ts': 'export const value = 1;\n' });

  const published = await f.run('publish', '--body-file', f.body, '--skip-review-request');

  assert.equal(published.publicationMode, 'full');
  assert.equal(published.publicationProvenance, 'automatic-v1');
  assert.equal(published.publicationPolicy.classification, 'full-required');
  assert.equal(published.localVerifiedHead, head);
  assert.equal(workflowSummary(published).localGateStatus, 'passed');
  assert.ok(localGates(f.calls).length > 0);
});

test('default publication only skips CI helpers and runs local gates for runtime or unknown CI scripts', async t => {
  for (const [path, mode] of [
    ['scripts/ci/check-context.mjs', 'push-only'],
    ['scripts/ci/check-runtime.mjs', 'full'],
    ['scripts/ci/run-runtime-tests.mjs', 'full'],
    ['scripts/ci/unreviewed-helper.mjs', 'full'],
  ]) {
    await t.test(path, async t => {
      const f = await checkout(t);
      const head = await setCandidate(f, { [path]: '// candidate\n' });
      const published = await f.run('publish', '--body-file', f.body, '--skip-review-request');

      assert.equal(published.publicationMode, mode);
      if (mode === 'full') {
        assert.equal(published.localVerifiedHead, head);
        assert.equal(workflowSummary(published).localGateStatus, 'passed');
        assert.ok(localGates(f.calls).length > 0);
      } else {
        assert.equal(published.localVerifiedHead, undefined);
        assert.equal(workflowSummary(published).localGateStatus, 'skipped');
        assert.equal(localGates(f.calls).length, 0);
      }
    });
  }
});

test('automatic publication blocks before push when the exact Git diff cannot be read', async t => {
  const f = await checkout(t);
  await setCandidate(f, { 'docs/contributor-guide.md': '# Guide\n' });
  const execute = (binary, args, cwd, timeout) => {
    if (binary === 'git' && args[0] === 'diff' && args[1] === '--name-status') throw new Error('range read failed');
    return f.execute(binary, args, cwd, timeout);
  };

  await assert.rejects(
    runWorkflow(['publish', '--body-file', f.body, '--summary', 'add the example workflow', '--skip-review-request', '--root', f.root], { execute }),
    /Could not read the exact base-to-candidate Git diff: range read failed/,
  );
  assert.equal(
    f.calls.some(call => call[0] === 'git' && call[1] === 'push'),
    false,
  );
});

test('eligible automatic push-only publication can complete after current-head CI without claiming local gates', async t => {
  const f = await checkout(t);
  const head = await setCandidate(f, { 'docs/contributor-guide.md': '# Guide\n' });
  const published = await f.run('publish', '--body-file', f.body, '--skip-review-request');
  const path = join(f.root, '.agent-work/pr-workflow/010-tooling-example.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.appLink = { url: f.e.pr.url, repository: 'example/project', number: f.e.pr.number };
  await writeFile(path, JSON.stringify(saved));
  const completed = await f.run('complete');

  assert.equal(completed.status, 'READY_FOR_HUMAN');
  assert.equal(completed.completion.head, head);
  assert.equal(completed.completion.localGates, 'skipped');
  assert.equal(completed.completion.publicationProvenance, 'automatic-v1');
  assert.equal(completed.localVerifiedHead, undefined);
  assert.equal(workflowSummary(completed).localGateStatus, 'skipped');
  assert.equal(published.publicationMode, 'push-only');
});

test('completion is refused without a code-review receipt for the current head', async t => {
  const f = await checkout(t);
  await setCandidate(f, { 'docs/contributor-guide.md': '# Guide\n' });
  await f.run('publish', '--body-file', f.body, '--skip-review-request');
  const path = join(f.root, '.agent-work/pr-workflow/010-tooling-example.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.appLink = { url: f.e.pr.url, repository: 'example/project', number: f.e.pr.number };
  await writeFile(path, JSON.stringify(saved));

  await assert.rejects(runWorkflow(['complete', '--root', f.root], { execute: f.execute }), /Completion requires a code-review receipt for the current head; run record-review/);
});

test('record-review refuses a receipt whose head is not the checkout HEAD', async t => {
  const f = await checkout(t);

  await assert.rejects(recordReview(f, 'b'.repeat(40)), /receipt head must match the current checkout HEAD/);
});

test('record-review refuses a non-object receipt', async t => {
  const f = await checkout(t);

  await assert.rejects(recordRawReview(f, null), /review receipt must be a JSON object/);
});

test('record-review refuses a receipt that does not name exactly two axes', async t => {
  const f = await checkout(t);

  await assert.rejects(
    recordRawReview(f, { base: git(f.root, 'rev-parse', 'origin/development'), head: git(f.root, 'rev-parse', 'HEAD'), axes: [{ name: 'standards', findings: [] }] }),
    /exactly two axes/,
  );
});

test('record-review refuses findings given as a count instead of the findings themselves', async t => {
  const f = await checkout(t);

  await assert.rejects(
    recordRawReview(f, {
      base: git(f.root, 'rev-parse', 'origin/development'),
      head: git(f.root, 'rev-parse', 'HEAD'),
      axes: [
        { name: 'standards', findings: 2 },
        { name: 'spec', findings: [] },
      ],
    }),
    /findings as an array of strings/,
  );
});

test('record-review refuses a review of the empty diff', async t => {
  const f = await checkout(t);
  const head = git(f.root, 'rev-parse', 'HEAD');

  await assert.rejects(
    recordRawReview(f, {
      base: head,
      head,
      axes: [
        { name: 'standards', findings: [] },
        { name: 'spec', findings: [] },
      ],
      reports: reportsFor(f),
    }),
    /a review of the empty diff observed nothing/,
  );
});

test('record-review refuses a receipt whose axis reports are absent', async t => {
  const f = await checkout(t);

  await assert.rejects(
    recordRawReview(f, {
      base: git(f.root, 'rev-parse', 'origin/development'),
      head: git(f.root, 'rev-parse', 'HEAD'),
      axes: [
        { name: 'standards', findings: [] },
        { name: 'spec', findings: [] },
      ],
      reports: [join(f.root, '.agent-work/standards.md'), join(f.root, '.agent-work/no-such-spec.md')],
    }),
    /is missing or empty/,
  );
});

test('record-review refuses an axis name that is not a string', async t => {
  const f = await checkout(t);

  await assert.rejects(
    recordRawReview(f, {
      base: git(f.root, 'rev-parse', 'origin/development'),
      head: git(f.root, 'rev-parse', 'HEAD'),
      axes: [
        { name: 2, findings: [] },
        { name: 'spec', findings: [] },
      ],
      reports: reportsFor(f),
    }),
    /non-empty name and its findings as an array of strings/,
  );
});

test('record-review refuses a base SHA that is neither 40 nor 64 hex characters', async t => {
  const f = await checkout(t);

  await assert.rejects(
    recordRawReview(f, {
      base: 'a'.repeat(41),
      head: git(f.root, 'rev-parse', 'HEAD'),
      axes: [
        { name: 'standards', findings: [] },
        { name: 'spec', findings: [] },
      ],
      reports: reportsFor(f),
    }),
    /must name base and head as full commit SHAs/,
  );
});

test('record-review refuses a base that is not a commit in the repository', async t => {
  const f = await checkout(t);

  await assert.rejects(
    recordRawReview(f, {
      base: '1'.repeat(40),
      head: git(f.root, 'rev-parse', 'HEAD'),
      axes: [
        { name: 'standards', findings: [] },
        { name: 'spec', findings: [] },
      ],
      reports: reportsFor(f),
    }),
    /base must name a commit in this repository/,
  );
});

test('record-review refuses a base that is not an ancestor of the reviewed head', async t => {
  const f = await checkout(t);
  const head = git(f.root, 'rev-parse', 'HEAD');
  // An unrelated root commit: a real object, but not part of the reviewed history.
  let orphan;
  try {
    orphan = git(f.root, 'commit-tree', git(f.root, 'write-tree'), '-m', 'unrelated');
  } catch {
    orphan = null;
  }
  if (!orphan) return t.skip('cannot create an unrelated commit in this fixture');

  await assert.rejects(
    recordRawReview(f, {
      base: orphan,
      head,
      axes: [
        { name: 'standards', findings: [] },
        { name: 'spec', findings: [] },
      ],
      reports: reportsFor(f),
    }),
    /base must share history with the reviewed head|base must be an ancestor/,
  );
});

test('record-review refuses an empty report file', async t => {
  const f = await checkout(t);
  const empty = join(f.root, 'empty-report.md');
  await writeFile(empty, '');
  const filled = join(f.root, 'filled-report.md');
  await writeFile(filled, 'findings\n');

  await assert.rejects(
    recordRawReview(f, {
      base: git(f.root, 'rev-parse', 'origin/development'),
      head: git(f.root, 'rev-parse', 'HEAD'),
      axes: [
        { name: 'standards', findings: [] },
        { name: 'spec', findings: [] },
      ],
      reports: [empty, filled],
    }),
    /is missing or empty/,
  );
});

test('record-review refuses the same report file named for both axes', async t => {
  const f = await checkout(t);
  const report = join(f.root, 'both-axes.md');
  await writeFile(report, 'findings\n');

  await assert.rejects(
    recordRawReview(f, {
      base: git(f.root, 'rev-parse', 'origin/development'),
      head: git(f.root, 'rev-parse', 'HEAD'),
      axes: [
        { name: 'standards', findings: [] },
        { name: 'spec', findings: [] },
      ],
      reports: [report, report],
    }),
    /must name a different report for each axis/,
  );
});
test('record-review then completion retains the reviewed base, head and axes', async t => {
  const f = await checkout(t);
  const head = await setCandidate(f, { 'docs/contributor-guide.md': '# Guide\n' });
  await f.run('publish', '--body-file', f.body, '--skip-review-request');
  const path = join(f.root, '.agent-work/pr-workflow/010-tooling-example.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.appLink = { url: f.e.pr.url, repository: 'example/project', number: f.e.pr.number };
  await writeFile(path, JSON.stringify(saved));

  const reviewed = await recordReview(f, head);
  const completed = await runWorkflow(['complete', '--root', f.root], { execute: f.execute });

  assert.equal(reviewed.codeReview.head, head);
  assert.equal(completed.completion.codeReview.base, reviewed.codeReview.base);
  assert.equal(completed.completion.codeReview.head, head);
  assert.deepEqual(completed.completion.codeReview.axes, reviewed.codeReview.axes);
});

test('tampered automatic publication evidence cannot bypass local gates at completion', async t => {
  const f = await checkout(t);
  await setCandidate(f, { 'docs/contributor-guide.md': '# Guide\n' });
  await f.run('publish', '--body-file', f.body, '--skip-review-request');
  const path = join(f.root, '.agent-work/pr-workflow/010-tooling-example.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.appLink = { url: f.e.pr.url, repository: 'example/project', number: f.e.pr.number };
  saved.publicationPolicy.paths = ['src/tampered.ts'];
  await writeFile(path, JSON.stringify(saved));

  await assert.rejects(f.run('complete'), /Automatic publication policy is stale or inconsistent; completion requires local gates/);
});

test('merge and unknown commands are rejected before executing anything', async () => {
  let called = false;
  await assert.rejects(
    runWorkflow(['merge'], {
      execute() {
        called = true;
      },
    }),
    /Usage/,
  );
  assert.equal(called, false);
});

test('PR titles require their branch prefix and a short summary', () => {
  const e = evidence();
  e.pr.title = `${e.pr.headRefName}: add the example workflow`;
  assert.equal(assess(e).status, 'READY_FOR_HUMAN');
  for (const title of [e.pr.headRefName, `${e.pr.headRefName}: `, 'feat/002-other: summary', `${e.pr.headRefName}: ${'x'.repeat(81)}`, `${e.pr.headRefName}: two\nlines`]) {
    e.pr.title = title;
    assert.equal(assess(e).status, 'BLOCKED', title);
  }
});

test('publishing rejects missing or invalid summaries before executing commands', async () => {
  let called = false;
  for (const args of [[], ['--summary', ' '], ['--summary', 'x'.repeat(81)], ['--summary', 'two\nlines']]) {
    await assert.rejects(
      runWorkflow(['publish', '--body-file', 'body.md', ...args], {
        execute() {
          called = true;
        },
      }),
      /summary/,
    );
  }
  assert.equal(called, false);
});

test('failed, missing, skipped, spoofed, or superseded CI cannot be accepted', () => {
  for (const conclusion of ['failure', 'skipped', 'cancelled', 'neutral']) {
    const e = evidence();
    e.checks[0].conclusion = conclusion;
    assert.equal(assess(e).status, 'NEEDS_FIX');
  }
  const e = evidence();
  e.checks[0].app.slug = 'another-app';
  assert.equal(assess(e).status, 'WAITING_CI');
  e.checks[0].app.slug = 'github-actions';
  e.checks[0].head_sha = 'old';
  assert.equal(assess(e).status, 'WAITING_CI');
  e.checks[0].head_sha = e.head;
  e.checks.push({ ...e.checks[0], id: 99, status: 'in_progress', conclusion: null });
  assert.equal(assess(e).status, 'WAITING_CI');
});

test('unresolved comments remain visible and advisory while incomplete or mismatched evidence blocks', () => {
  const e = evidence();
  e.pr.reviewThreads.nodes.push({ id: 'thread', isResolved: false, isOutdated: true });
  assert.equal(assess(e).status, 'READY_FOR_HUMAN');
  assert.equal(assess(e).unresolved[0].id, 'thread');
  e.pr.reviewThreads.nodes = [];
  e.pr.reviews.nodes[0].author.__typename = 'User';
  assert.equal(assess(e).status, 'READY_FOR_HUMAN');
  e.pr.reviews.pageInfo.hasPreviousPage = true;
  assert.equal(assess(e).status, 'BLOCKED');
  e.pr.reviews.pageInfo.hasPreviousPage = false;
  e.pr.headRefOid = 'different';
  assert.equal(assess(e).status, 'BLOCKED');
  const waiting = evidence();
  waiting.pr.reviews.nodes[0].commit.oid = 'old';
  waiting.pr.reviewDecision = 'CHANGES_REQUESTED';
  waiting.pr.reviewThreads.nodes = [{ id: 'old-finding', isResolved: false }];
  assert.equal(assess(waiting).status, 'READY_FOR_HUMAN', 'comments are advisory under the human merge policy');
});

test('PR sizing reports generated changes and binaries separately without hiding them', () => {
  assert.deepEqual(changedLines('700\t400\tsrc/code.ts\n200\t100\tpackage-lock.json\n-\t-\tasset.png\n'), { reviewable: 1100, generated: 300, binaries: 1, overTarget: true });
});

test('routine summaries expose comments and log paths without historical command output', () => {
  const summary = workflowSummary({
    schemaVersion: 1,
    repairRounds: [],
    localVerification: { head: 'abc', tests: 'private lengthy test transcript' },
    gateLogs: { tests: { status: 'passed', log: 'tests.log', exitCode: 0, summary: 'lengthy output' } },
    observation: { unresolved: [{ id: 'thread', isOutdated: false, comments: { nodes: [{ url: 'https://example.invalid/comment', body: 'lengthy comment' }] } }] },
  });
  assert.equal(summary.localVerifiedHead, 'abc');
  assert.equal(summary.logs.tests.log, 'tests.log');
  assert.equal(summary.unresolved[0].id, 'thread');
  assert.doesNotMatch(JSON.stringify(summary), /lengthy/);
  assert.equal(
    workflowSummary({ schemaVersion: 1, repairRounds: [], observation: { reason: 'Update the feature branch against development.' } }).reason,
    'Update the feature branch against development.',
  );
});

test('record-review accepts a recorded opt-out with its reason', async t => {
  const f = await checkout(t);

  const recorded = await recordRawReview(f, { head: git(f.root, 'rev-parse', 'HEAD'), optedOut: true, reason: 'User asked to skip review for this batch.' });
  assert.equal(recorded.codeReview.optedOut, true);
  assert.equal(recorded.codeReview.reason, 'User asked to skip review for this batch.');
});

test('record-review refuses an opt-out that does not record the user request', async t => {
  const f = await checkout(t);

  await assert.rejects(recordRawReview(f, { head: git(f.root, 'rev-parse', 'HEAD'), optedOut: true, reason: '  ' }), /must record the user request that skipped the review/);
});

test('record-review refuses a base and head with identical content', async t => {
  const f = await checkout(t);
  const head = git(f.root, 'rev-parse', 'HEAD');
  // A second commit carrying the same tree: a real descendant, but nothing was changed.
  const same = git(f.root, 'commit-tree', git(f.root, 'rev-parse', `${head}^{tree}`), '-p', head, '-m', 'empty');
  git(f.root, 'update-ref', 'HEAD', same);

  await assert.rejects(
    recordRawReview(f, {
      base: head,
      head: same,
      axes: [
        { name: 'standards', findings: [] },
        { name: 'spec', findings: [] },
      ],
      reports: reportsFor(f),
    }),
    /must differ in content|observed nothing/,
  );
});
