import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';
import { runIssueFollowup } from '../../scripts/agents/paired-issue-followup.mjs';
import { runIssueCompletion } from '../../scripts/agents/complete-paired-issues.mjs';
import { completionMarker } from '../../scripts/agents/paired-issue-state.mjs';
import { ACTIVE_POLICY_ID, POLICIES } from '../../scripts/ci/required-checks.mjs';
import { fixture, markerFor, mergePair, privateRepository, publicRepository, requiredChecks } from './support/complete-paired-issues-fixture.mjs';
import { projectFixture } from './support/issue-project-fixture.mjs';

test('closed issues with failed Project Done update remain pending in follow-up', async t => {
  const f = await fixture(t, { loseCloseResponse: false });
  const p = await projectFixture(f.root, f.execute);
  mergePair(f);
  await savePairRecord(f);
  p.state.failEdit = true;
  await assert.rejects(runIssueCompletion([...f.args, '--apply'], { execute: p.execute }), /project edit failed/);
  const args = ['--pr', f.prs.primary.url, '--key', 'localized-bug', '--root', f.root];
  assert.equal((await runIssueFollowup(args, { execute: p.execute })).items[0].status, 'PROJECT_PENDING');
  const preview = await runIssueFollowup([...args, '--evidence-file', f.evidenceFile], { execute: p.execute });
  assert.equal(preview.items[0].status, 'READY_TO_COMPLETE');
  assert.match(preview.items[0].applyCommand, /--apply/);
  assert.deepEqual(p.state.writes, ['add']);
});

test('fixture required checks derive from the active shared policy', () => {
  // An oracle that recomputes createPolicyState(ACTIVE_POLICY_ID) could not detect a wrong activation,
  // so the expected names are literal and ci-v1 is asserted unequal.
  const SEVEN = [
    'static-lint', 'static-types', 'repository-policy', 'pr-metadata', 'build', 'contributor-tooling-tests', 'runtime-tests',
  ];
  assert.equal(ACTIVE_POLICY_ID, 'ci-v5', 'Narrowed gating makes the four ci-v5 names current');
  assert.deepEqual([...requiredChecks], [...POLICIES[ACTIVE_POLICY_ID].required], 'the fixture mirrors the current names');
  assert.notDeepEqual([...requiredChecks], SEVEN, 'the build and test lanes no longer gate a merge');
  assert.notDeepEqual([...requiredChecks], [...POLICIES['ci-v1'].required], 'the four legacy names are not current');
});

async function savePairRecord(f, key = 'localized-bug') {
  const directory = join(f.root, '.agent-work', 'paired-issues');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${key}.json`), JSON.stringify({
    schemaVersion: 1,
    key,
    marker: markerFor(key),
    targets: { primary: publicRepository, submission: privateRepository },
    receipts: {
      primary: { number: f.publicIssue.number, url: f.publicIssue.html_url },
      submission: { number: f.privateIssue.number, url: f.privateIssue.html_url },
    },
  }));
}

test('unassociated local keys report paired issue state and exact preview command without writes', async t => {
  const f = await fixture(t);
  await savePairRecord(f);

  const result = await runIssueFollowup(['--pr', f.prs.primary.url, '--root', f.root], { execute: f.execute });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].status, 'MISSING_ASSOCIATION');
  assert.equal(result.items[0].association, 'NOT_ASSERTED');
  assert.deepEqual(result.items[0].issues, { primary: 'open', submission: 'open' });
  assert.deepEqual(result.items[0].issueNumbers, { primary: 11, submission: 23 });
  assert.match(result.items[0].previewCommand, /--key localized-bug --pr 'https:\/\/github\.com\/example\/public\/pull\/7' --evidence-file <evidence\.json>/);
  assert.equal(result.items[0].applyCommand, undefined);
  assert.deepEqual(f.writes, []);
});

test('unassociated partial closure requires association while an explicit key permits recovery', async t => {
  const f = await fixture(t);
  await savePairRecord(f);
  f.publicIssue.state = 'closed';

  const discovered = await runIssueFollowup(['--pr', f.prs.primary.url, '--root', f.root], { execute: f.execute });

  assert.equal(discovered.items[0].status, 'MISSING_ASSOCIATION');
  assert.equal(discovered.items[0].association, 'NOT_ASSERTED');
  assert.equal(discovered.items[0].completionState, 'RECOVER_PARTIAL');
  assert.match(discovered.items[0].nextStep, /Confirm that this public PR resolves this stable key/);

  const explicit = await runIssueFollowup(['--pr', f.prs.primary.url, '--key', 'localized-bug', '--root', f.root], { execute: f.execute });

  assert.equal(explicit.items[0].status, 'RECOVER_PARTIAL');
  assert.equal(explicit.items[0].association, 'EXPLICIT');
  assert.deepEqual(f.writes, []);
});

test('explicit key without evidence requests evidence and never previews or writes', async t => {
  const f = await fixture(t);
  await savePairRecord(f);

  const result = await runIssueFollowup(['--pr', f.prs.primary.url, '--key', 'localized-bug', '--root', f.root], { execute: f.execute });

  assert.equal(result.items[0].status, 'MISSING_EVIDENCE');
  assert.equal(result.items[0].association, 'EXPLICIT');
  assert.equal(result.items[0].completionState, 'NOT_STARTED');
  assert.equal(result.items[0].acceptanceEvidence, 'MISSING');
  assert.deepEqual(f.writes, []);
});

test('explicit evidence invokes only the existing preview and exact public CI gates control readiness', async t => {
  const f = await fixture(t);
  await savePairRecord(f);
  mergePair(f);
  f.checks.pop();

  const result = await runIssueFollowup([
    '--pr', f.prs.primary.url,
    '--key', 'localized-bug',
    '--evidence-file', f.evidenceFile,
    '--root', f.root,
  ], { execute: f.execute });

  assert.equal(result.items[0].status, 'WAITING_CI');
  assert.equal(result.items[0].previewStatus, 'WAITING_CI');
  assert.equal(result.items[0].applyCommand, undefined);
  assert.equal(f.checks.length, requiredChecks.length - 1);
  assert.deepEqual(f.writes, []);
  assert.equal(f.publicIssue.state, 'open');
  assert.equal(f.privateIssue.state, 'open');
});

test('open PRs wait and failed exact-head checks are not eligible for apply', async t => {
  const open = await fixture(t);
  await savePairRecord(open);
  const waiting = await runIssueFollowup([
    '--pr', open.prs.primary.url,
    '--key', 'localized-bug',
    '--evidence-file', open.evidenceFile,
    '--root', open.root,
  ], { execute: open.execute });
  assert.equal(waiting.items[0].status, 'WAITING_PR');
  assert.equal(waiting.items[0].applyCommand, undefined);
  assert.deepEqual(open.writes, []);

  const failed = await fixture(t);
  await savePairRecord(failed);
  mergePair(failed);
  failed.checks[0].conclusion = 'failure';
  const blocked = await runIssueFollowup([
    '--pr', failed.prs.primary.url,
    '--key', 'localized-bug',
    '--evidence-file', failed.evidenceFile,
    '--root', failed.root,
  ], { execute: failed.execute });
  assert.equal(blocked.items[0].status, 'NOT_MET');
  assert.equal(blocked.items[0].previewStatus, 'BLOCKED');
  assert.equal(blocked.items[0].applyCommand, undefined);
  assert.deepEqual(failed.writes, []);
});

test('merged paired PRs with all current successful public exact-head checks are preview eligible only', async t => {
  const f = await fixture(t);
  await savePairRecord(f);
  mergePair(f);

  const result = await runIssueFollowup([
    '--pr', f.prs.primary.url,
    '--key', 'localized-bug',
    '--evidence-file', f.evidenceFile,
    '--root', f.root,
  ], { execute: f.execute });

  assert.equal(result.items[0].status, 'READY_TO_COMPLETE');
  assert.equal(result.items[0].previewStatus, 'READY_TO_COMPLETE');
  assert.match(result.items[0].applyCommand, /--apply$/);
  assert.equal(result.items[0].acceptanceEvidence, 'PROVIDED_NOT_ASSESSED');
  assert.match(result.items[0].nextStep, /review the acceptance evidence yourself/i);
  assert.deepEqual(f.writes, []);
  assert.equal(f.publicIssue.state, 'open');
  assert.equal(f.privateIssue.state, 'open');
});

test('partial issue closure is surfaced for recovery and does not repeat remote effects', async t => {
  const f = await fixture(t);
  await savePairRecord(f);
  mergePair(f);
  assert.equal((await runIssueCompletion(f.args, { execute: f.execute })).status, 'READY_TO_COMPLETE');
  const completionPath = join(f.root, '.agent-work', 'paired-issue-completion', 'localized-bug.json');
  const completion = JSON.parse(await readFile(completionPath, 'utf8'));
  completion.applyStarted = true;
  completion.progress.primary.closed = true;
  await writeFile(completionPath, JSON.stringify(completion));
  f.publicIssue.state = 'closed';

  const result = await runIssueFollowup([
    '--pr', f.prs.primary.url,
    '--key', 'localized-bug',
    '--evidence-file', f.evidenceFile,
    '--root', f.root,
  ], { execute: f.execute });

  assert.equal(result.items[0].status, 'RECOVER_PARTIAL');
  assert.equal(result.items[0].previewStatus, 'READY_TO_COMPLETE');
  assert.match(result.items[0].applyCommand, /--apply$/);
  assert.equal(result.items[0].completionState, 'RECOVER_PARTIAL');
  assert.deepEqual(result.items[0].issues, { primary: 'closed', submission: 'open' });
  assert.deepEqual(f.writes, []);
});

test('a retained different PR association is not retargeted or previewed', async t => {
  const f = await fixture(t);
  await savePairRecord(f);
  const completionDirectory = join(f.root, '.agent-work', 'paired-issue-completion');
  await mkdir(completionDirectory, { recursive: true });
  await writeFile(join(completionDirectory, 'localized-bug.json'), JSON.stringify({
    schemaVersion: 1,
    key: 'localized-bug',
    issueMarker: markerFor('localized-bug'),
    completionMarker: completionMarker(publicRepository, 'localized-bug'),
    targets: { primary: publicRepository, submission: privateRepository },
    issues: {
      primary: { number: 11, url: f.publicIssue.html_url },
      submission: { number: 23, url: f.privateIssue.html_url },
    },
    resolvingPr: {
      primary: { repository: publicRepository, number: 7, url: f.prs.primary.url, branch: 'feat/tooling-example', base: 'development' },
      submission: { repository: privateRepository, number: 9, url: f.prs.submission.url, branch: 'feat/tooling-example', base: 'development' },
    },
    evidenceSha256: 'a'.repeat(64),
    progress: { primary: {}, submission: {} },
  }));

  const result = await runIssueFollowup([
    '--pr', 'https://github.com/example/public/pull/8',
    '--key', 'localized-bug',
    '--evidence-file', f.evidenceFile,
    '--root', f.root,
  ], { execute: f.execute });

  assert.equal(result.items[0].status, 'ASSOCIATION_MISMATCH');
  assert.equal(result.items[0].previewStatus, undefined);
  assert.deepEqual(f.writes, []);
});

test('unknown keys are not invented and evidence cannot be applied to discovered candidates', async t => {
  const f = await fixture(t);

  const empty = await runIssueFollowup(['--pr', f.prs.primary.url, '--root', f.root], { execute: f.execute });
  assert.equal(empty.status, 'NO_CANDIDATES');
  assert.deepEqual(empty.items, []);
  await assert.rejects(
    runIssueFollowup(['--pr', f.prs.primary.url, '--evidence-file', f.evidenceFile, '--root', f.root], { execute: f.execute }),
    /one explicit --key/,
  );
  await savePairRecord(f);
  const unknown = await runIssueFollowup(['--pr', f.prs.primary.url, '--key', 'missing-ticket', '--root', f.root], { execute: f.execute });
  assert.equal(unknown.items[0].status, 'MISSING_ASSOCIATION');
  assert.equal(unknown.items[0].issues, undefined);
  assert.equal(unknown.items[0].key, 'missing-ticket');
  assert.deepEqual(f.writes, []);
});

test('malformed evidence remains rejected by the existing completion helper', async t => {
  const f = await fixture(t);
  await savePairRecord(f);
  await writeFile(f.evidenceFile, '{"schemaVersion":1,"summary":"Missing acceptance entries","acceptance":[]}');

  await assert.rejects(runIssueFollowup([
    '--pr', f.prs.primary.url,
    '--key', 'localized-bug',
    '--evidence-file', f.evidenceFile,
    '--root', f.root,
  ], { execute: f.execute }), /at least one acceptance entry/i);
  assert.deepEqual(f.writes, []);
});
