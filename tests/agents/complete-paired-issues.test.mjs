import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';
import { runIssueCompletion } from '../../scripts/agents/complete-paired-issues.mjs';
import { ACTIVE_POLICY_ID, POLICIES, evaluateRequired, parseHistoricalBindings } from '../../scripts/ci/required-checks.mjs';
import { branch, completionMarkerFor, fixture, markerFor, mergePair, privateRepository, publicHead, publicRepository, requiredChecks } from './support/complete-paired-issues-fixture.mjs';

const historicalBinding = { repositoryId: 101, headRepositoryId: 101, number: 7, head: publicHead, tree: 'c'.repeat(40), policy: 'ci-v1' };

function useHistoricalChecks(f) {
  f.checks.splice(0, f.checks.length, ...POLICIES['ci-v1'].required.map((name, id) => ({ id: id + 1, name, head_sha: publicHead, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } })));
}

test('an audited historical merged pair uses its bound policy and preserves preview/apply safeguards', async t => {
  const f = await fixture(t, { historicalBindings: [historicalBinding], loseCloseResponse: false });
  mergePair(f);
  useHistoricalChecks(f);
  assert.equal((await runIssueCompletion(f.args, { execute: f.execute })).status, 'READY_TO_COMPLETE');
  assert.deepEqual(f.writes, []);
  assert.equal((await runIssueCompletion([...f.args, '--apply'], { execute: f.execute })).status, 'COMPLETED');
  assert.equal(f.publicIssue.state, 'closed');
  assert.equal(f.privateIssue.state, 'closed');
});

test('historical completion refuses every substituted binding field before remote writes', async t => {
  for (const [field, value] of Object.entries({ repositoryId: 102, headRepositoryId: 102, number: 8, head: 'd'.repeat(40), tree: 'd'.repeat(40) })) {
    await t.test(field, async t => {
      const f = await fixture(t, { historicalBindings: [{ ...historicalBinding, [field]: value }] });
      mergePair(f);
      useHistoricalChecks(f);
      assert.equal((await runIssueCompletion([...f.args, '--apply'], { execute: f.execute })).status, 'WAITING_CI');
      assert.deepEqual(f.writes, []);
      assert.equal(f.publicIssue.state, 'open');
      assert.equal(f.privateIssue.state, 'open');
    });
  }
});

test('historical completion requires live merged identity and never falls back between check policies', async t => {
  for (const state of ['OPEN', 'CLOSED']) {
    const f = await fixture(t, { historicalBindings: [historicalBinding] });
    mergePair(f);
    f.prs.primary.state = state;
    useHistoricalChecks(f);
    const result = await runIssueCompletion([...f.args, '--apply'], { execute: f.execute });
    assert.equal(result.status, state === 'OPEN' ? 'WAITING_PR' : 'BLOCKED');
    assert.deepEqual(f.writes, []);
  }
  const changed = await fixture(t, { historicalBindings: [historicalBinding], publicPull: { merged_at: null } });
  mergePair(changed);
  useHistoricalChecks(changed);
  await assert.rejects(runIssueCompletion([...changed.args, '--apply'], { execute: changed.execute }), /binding identity changed or is not merged/);
  assert.deepEqual(changed.writes, []);

  const currentOnly = await fixture(t, { historicalBindings: [historicalBinding] });
  mergePair(currentOnly);
  assert.equal((await runIssueCompletion([...currentOnly.args, '--apply'], { execute: currentOnly.execute })).status, 'WAITING_CI');
  assert.deepEqual(currentOnly.writes, []);
});

test('historical completion still refuses stale, foreign-app and latest failed checks without effects', async t => {
  for (const kind of ['stale', 'foreign', 'failed-rerun']) {
    const f = await fixture(t, { historicalBindings: [historicalBinding] });
    mergePair(f);
    useHistoricalChecks(f);
    if (kind === 'stale') for (const check of f.checks) check.head_sha = 'd'.repeat(40);
    if (kind === 'foreign') for (const check of f.checks) check.app.slug = 'other-app';
    if (kind === 'failed-rerun') f.checks.push({ ...f.checks[0], id: 100, conclusion: 'failure' });
    assert.equal((await runIssueCompletion([...f.args, '--apply'], { execute: f.execute })).status, kind === 'failed-rerun' ? 'BLOCKED' : 'WAITING_CI');
    assert.deepEqual(f.writes, []);
    assert.equal(f.publicIssue.state, 'open');
    assert.equal(f.privateIssue.state, 'open');
  }
});

test('an open paired resolving PR returns WAITING_PR without remote writes', async t => {
  const f = await fixture(t);
  const open = await runIssueCompletion(f.args, { execute: f.execute });
  assert.equal(open.status, 'WAITING_PR');
  assert.deepEqual(f.writes, []);
});

test('a merged PR pair previews READY_TO_COMPLETE without remote writes', async t => {
  const f = await fixture(t);
  mergePair(f);
  const preview = await runIssueCompletion(f.args, { execute: f.execute });
  assert.equal(preview.status, 'READY_TO_COMPLETE');
  assert.deepEqual(f.writes, []);
});

test('apply closes both paired issues and recovers a lost close response without duplicate comments', async t => {
  const f = await fixture(t);
  mergePair(f);
  await assert.rejects(runIssueCompletion([...f.args, '--apply'], { execute: f.execute }), /lost close response/);
  const recovered = await runIssueCompletion([...f.args, '--apply'], { execute: f.execute });
  assert.equal(recovered.status, 'COMPLETED');
  assert.deepEqual(f.repositories[publicRepository].issues[0].state, 'closed');
  assert.deepEqual(f.repositories[privateRepository].issues[0].state, 'closed');
  assert.equal(f.writes.filter(write => write.kind === 'comment').length, 2);
  assert.equal(f.writes.filter(write => write.kind === 'close').length, 2);
  assert.match(f.writes.find(write => write.kind === 'comment' && write.repository === publicRepository).body, new RegExp(f.prs.primary.url.replaceAll('/', '\\/')));
  assert.match(f.writes.find(write => write.kind === 'comment' && write.repository === privateRepository).body, new RegExp(f.prs.submission.url.replaceAll('/', '\\/')));
  assert.doesNotMatch(f.writes.find(write => write.kind === 'comment' && write.repository === publicRepository).body, /course\/private|github\.com\/course\/private/i);
});

test('lost comment responses recover from the shared marker without duplicating audit comments', async t => {
  const f = await fixture(t, { loseCommentResponse: publicRepository, loseCloseResponse: false });
  mergePair(f);
  await assert.rejects(runIssueCompletion([...f.args, '--apply'], { execute: f.execute }), /lost comment response/);
  assert.equal(f.publicIssue.comments.length, 1);
  assert.equal(f.privateIssue.comments.length, 0);

  const recovered = await runIssueCompletion([...f.args, '--apply'], { execute: f.execute });

  assert.equal(recovered.status, 'COMPLETED');
  assert.equal(f.writes.filter(write => write.kind === 'comment' && write.repository === publicRepository).length, 1);
  assert.equal(f.writes.filter(write => write.kind === 'comment' && write.repository === privateRepository).length, 1);
  assert.equal(f.writes.filter(write => write.kind === 'close').length, 2);
});

test('already closed issues stay untouched while the open counterpart is completed', async t => {
  const f = await fixture(t, { loseCloseResponse: false });
  mergePair(f);
  f.publicIssue.state = 'closed';

  const result = await runIssueCompletion([...f.args, '--apply'], { execute: f.execute });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(f.publicIssue.comments.length, 0);
  assert.equal(f.writes.some(write => write.repository === publicRepository), false);
  assert.equal(f.privateIssue.state, 'closed');
});

test('waiting previews accept revised evidence until an apply starts', async t => {
  const f = await fixture(t);
  const waiting = await runIssueCompletion(f.args, { execute: f.execute });
  assert.equal(waiting.status, 'WAITING_PR');
  await writeFile(f.evidenceFile, JSON.stringify({
    schemaVersion: 1,
    summary: 'Updated after review feedback.',
    acceptance: [{ criterion: 'The localized display is correct.', evidence: 'The revised focused check passed.' }],
  }));
  const stillWaiting = await runIssueCompletion(f.args, { execute: f.execute });
  assert.equal(stillWaiting.status, 'WAITING_PR');

  mergePair(f);
  const firstPreview = await runIssueCompletion(f.args, { execute: f.execute });
  assert.equal(firstPreview.status, 'READY_TO_COMPLETE');
  await writeFile(f.evidenceFile, JSON.stringify({
    schemaVersion: 1,
    summary: 'Final verified repair.',
    acceptance: [{ criterion: 'The localized display is correct.', evidence: 'Final verification passed.' }],
  }));
  const revisedPreview = await runIssueCompletion(f.args, { execute: f.execute });
  assert.equal(revisedPreview.status, 'READY_TO_COMPLETE');
  assert.deepEqual(f.writes, []);
});

test('feature heads may advance while PRs are open, then the merged current heads are checked', async t => {
  const f = await fixture(t);
  assert.equal((await runIssueCompletion(f.args, { execute: f.execute })).status, 'WAITING_PR');
  f.prs.primary.headRefOid = 'd'.repeat(40);
  f.prs.submission.headRefOid = 'e'.repeat(40);
  for (const check of f.checks) check.head_sha = f.prs.primary.headRefOid;
  mergePair(f);

  const result = await runIssueCompletion(f.args, { execute: f.execute });

  assert.equal(result.status, 'READY_TO_COMPLETE');
  assert.deepEqual(f.writes, []);
});

test('completion rejects a changed merged head after a ready preview', async t => {
  const f = await fixture(t);
  mergePair(f);
  assert.equal((await runIssueCompletion(f.args, { execute: f.execute })).status, 'READY_TO_COMPLETE');
  f.prs.primary.headRefOid = 'd'.repeat(40);
  for (const check of f.checks) check.head_sha = f.prs.primary.headRefOid;

  await assert.rejects(runIssueCompletion([...f.args, '--apply'], { execute: f.execute }), /heads.*changed after preview/i);
  assert.deepEqual(f.writes, []);
});

test('completion revalidates issue criteria before posting comments', async t => {
  const f = await fixture(t, { changeIssueBodyAtCheck: 1 });
  mergePair(f);

  await assert.rejects(runIssueCompletion([...f.args, '--apply'], { execute: f.execute }), /issue evidence changed before completion comments/i);
  assert.equal(f.publicIssue.state, 'open');
  assert.equal(f.privateIssue.state, 'open');
  assert.deepEqual(f.writes, []);
});

test('each close revalidates the other issue and leaves partial completion recorded on drift', async t => {
  const f = await fixture(t, { changePrivateIssueAfterPublicClose: true, loseCloseResponse: false });
  mergePair(f);

  await assert.rejects(runIssueCompletion([...f.args, '--apply'], { execute: f.execute }), /changed after preview/i);

  assert.equal(f.publicIssue.state, 'closed');
  assert.equal(f.privateIssue.state, 'open');
  assert.equal(f.writes.filter(write => write.kind === 'close' && write.repository === publicRepository).length, 1);
  assert.equal(f.writes.filter(write => write.kind === 'close' && write.repository === privateRepository).length, 0);
});

test('failing, spoofed, or incomplete exact-head checks and mismatched source trees deny apply', async t => {
  const failed = await fixture(t);
  mergePair(failed);
  failed.checks[0].conclusion = 'failure';
  const failure = await runIssueCompletion([...failed.args, '--apply'], { execute: failed.execute });
  assert.equal(failure.status, 'BLOCKED');
  assert.deepEqual(failed.writes, []);

  const skipped = await fixture(t);
  mergePair(skipped);
  skipped.checks[0].conclusion = 'skipped';
  const skip = await runIssueCompletion([...skipped.args, '--apply'], { execute: skipped.execute });
  assert.equal(skip.status, 'BLOCKED');
  assert.deepEqual(skipped.writes, []);

  const spoofed = await fixture(t);
  mergePair(spoofed);
  for (const check of spoofed.checks) check.app.slug = 'other-app';
  const spoof = await runIssueCompletion([...spoofed.args, '--apply'], { execute: spoofed.execute });
  assert.equal(spoof.status, 'WAITING_CI');
  assert.deepEqual(spoofed.writes, []);

  const stale = await fixture(t);
  mergePair(stale);
  for (const check of stale.checks) check.head_sha = 'f'.repeat(40);
  const staleReport = await runIssueCompletion([...stale.args, '--apply'], { execute: stale.execute });
  assert.equal(staleReport.status, 'WAITING_CI');
  assert.deepEqual(stale.writes, []);

  const mismatch = await fixture(t, { treeMismatch: true });
  mergePair(mismatch);
  const treeResult = await runIssueCompletion([...mismatch.args, '--apply'], { execute: mismatch.execute });
  assert.equal(treeResult.status, 'BLOCKED');
  assert.match(treeResult.reason, /trees/i);
  assert.deepEqual(mismatch.writes, []);
});

test('merged completion uses only the active policy and never a ci-v1 or unbound historical name set', async t => {
  parseHistoricalBindings(await readFile(new URL('../../config/legacy-ci-heads.json', import.meta.url), 'utf8'));
  assert.equal(ACTIVE_POLICY_ID, 'ci-v5', 'Narrowed gating makes the four ci-v5 names current');
  assert.deepEqual([...requiredChecks], [...POLICIES['ci-v5'].required]);

  const v1 = await fixture(t);
  mergePair(v1);
  v1.checks.splice(0, v1.checks.length, ...POLICIES['ci-v1'].required.map((name, id) => ({ id: id + 1, name, head_sha: publicHead, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } })));
  const wrongPolicy = await runIssueCompletion([...v1.args, '--apply'], { execute: v1.execute });
  assert.equal(wrongPolicy.status, 'WAITING_CI', 'ci-v1 names do not satisfy the active ci-v5 policy');
  assert.deepEqual(v1.writes, []);

  const head = publicHead;
  const oldRuns = POLICIES['ci-v1'].required.map((name, id) => ({ id: id + 1, name, head_sha: head, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }));
  const newRuns = requiredChecks.map((name, id) => ({ id: id + 1, name, head_sha: head, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }));
  assert.equal(evaluateRequired({ policy: POLICIES['ci-v5'], head, checks: oldRuns }).status, 'WAITING');
  assert.equal(evaluateRequired({ policy: POLICIES['ci-v1'], head, checks: newRuns }).status, 'WAITING');
  assert.equal(evaluateRequired({ policy: POLICIES['ci-v5'], head, checks: newRuns }).status, 'READY');
});

test('cross-repository PRs, duplicate submission PRs, and changed PR identity are refused', async t => {
  const cross = await fixture(t);
  mergePair(cross);
  cross.prs.primary.isCrossRepository = true;
  await assert.rejects(runIssueCompletion([...cross.args, '--apply'], { execute: cross.execute }), /cross-repository/i);
  assert.deepEqual(cross.writes, []);

  const duplicate = await fixture(t);
  mergePair(duplicate);
  duplicate.extraSubmissionPRs.push({
    number: 10,
    url: `https://github.com/${privateRepository}/pull/10`,
    baseRefName: 'development',
    headRefName: branch,
    state: 'MERGED',
  });
  await assert.rejects(runIssueCompletion([...duplicate.args, '--apply'], { execute: duplicate.execute }), /multiple submission PRs/i);
  assert.deepEqual(duplicate.writes, []);

  const replacement = await fixture(t);
  mergePair(replacement);
  assert.equal((await runIssueCompletion(replacement.args, { execute: replacement.execute })).status, 'READY_TO_COMPLETE');
  replacement.prs.submission.number = 10;
  replacement.prs.submission.url = `https://github.com/${privateRepository}/pull/10`;
  await assert.rejects(runIssueCompletion([...replacement.args, '--apply'], { execute: replacement.execute }), /resolving PR changed/i);
  assert.deepEqual(replacement.writes, []);
});

test('changed targets and conflicting retained issue receipts fail before writes', async t => {
  const target = await fixture(t);
  mergePair(target);
  assert.equal((await runIssueCompletion(target.args, { execute: target.execute })).status, 'READY_TO_COMPLETE');
  const otherRepository = 'course/replaced';
  target.repositories[otherRepository] = {
    metadata: { ...target.repositories[privateRepository].metadata, nameWithOwner: otherRepository },
    issues: [{ ...target.privateIssue, html_url: `https://github.com/${otherRepository}/issues/23`, comments: [] }],
    pr: { ...target.prs.submission, url: `https://github.com/${otherRepository}/pull/9` },
  };
  target.remoteTargets.submission = otherRepository;
  await assert.rejects(runIssueCompletion([...target.args, '--apply'], { execute: target.execute }), /targets.*changed/i);
  assert.deepEqual(target.writes, []);

  const receipt = await fixture(t);
  const issueRecordDir = join(receipt.root, '.agent-work', 'paired-issues');
  await mkdir(issueRecordDir, { recursive: true });
  await writeFile(join(issueRecordDir, 'localized-bug.json'), JSON.stringify({
    schemaVersion: 1,
    key: 'localized-bug',
    marker: markerFor('localized-bug'),
    targets: { primary: publicRepository, submission: privateRepository },
    receipts: { primary: { number: 99, url: `https://github.com/${publicRepository}/issues/99` }, submission: null },
  }));
  await assert.rejects(runIssueCompletion(receipt.args, { execute: receipt.execute }), /receipt no longer matches/i);
  assert.deepEqual(receipt.writes, []);
});

test('duplicate ticket markers, marker comments, and escaped private identity are refused', async t => {
  const duplicateIssue = await fixture(t);
  duplicateIssue.repositories[publicRepository].issues.push({
    ...duplicateIssue.publicIssue,
    number: 99,
    html_url: `https://github.com/${publicRepository}/issues/99`,
    comments: [],
  });
  await assert.rejects(runIssueCompletion(duplicateIssue.args, { execute: duplicateIssue.execute }), /multiple issues/i);
  assert.deepEqual(duplicateIssue.writes, []);

  const markedPr = await fixture(t);
  markedPr.publicIssue.pull_request = { url: `https://github.com/${publicRepository}/pull/11` };
  await assert.rejects(runIssueCompletion(markedPr.args, { execute: markedPr.execute }), /pull request/i);
  assert.deepEqual(markedPr.writes, []);

  const conflict = await fixture(t);
  mergePair(conflict);
  conflict.publicIssue.comments.push(`Conflicting audit entry.\n${completionMarkerFor('localized-bug')}`);
  await assert.rejects(runIssueCompletion(conflict.args, { execute: conflict.execute }), /conflicting evidence/i);
  assert.deepEqual(conflict.writes, []);

  const escaped = await fixture(t);
  await writeFile(escaped.evidenceFile, '{"schemaVersion":1,"summary":"course\\u002fprivate","acceptance":[{"criterion":"criterion","evidence":"evidence"}]}');
  await assert.rejects(runIssueCompletion(escaped.args, { execute: escaped.execute }), /private repository identity/i);
  assert.deepEqual(escaped.writes, []);
});

test('malformed or oversized evidence is refused while large local evidence yields bounded comments', async t => {
  const malformed = await fixture(t);
  await writeFile(malformed.evidenceFile, '{"schemaVersion":1,"summary":"ok","acceptance":[]}');
  await assert.rejects(runIssueCompletion(malformed.args, { execute: malformed.execute }), /at least one acceptance entry/i);
  assert.deepEqual(malformed.writes, []);

  const tooLarge = await fixture(t, { loseCloseResponse: false });
  mergePair(tooLarge);
  const evidence = {
    schemaVersion: 1,
    summary: 'x'.repeat(65_390),
    acceptance: [{ criterion: 'criterion', evidence: 'evidence' }],
  };
  const content = JSON.stringify(evidence);
  assert.ok(Buffer.byteLength(content) <= 65_536);
  await writeFile(tooLarge.evidenceFile, content);
  assert.equal((await runIssueCompletion([...tooLarge.args, '--apply'], { execute: tooLarge.execute })).status, 'COMPLETED');
  for (const write of tooLarge.writes.filter(write => write.kind === 'comment')) {
    assert.ok(Buffer.byteLength(write.body) < 1000);
    assert.equal(write.body.includes(evidence.summary), false);
  }
  const oversized = await fixture(t);
  await writeFile(oversized.evidenceFile, 'x'.repeat(65_537));
  await assert.rejects(runIssueCompletion(oversized.args, { execute: oversized.execute }), /Evidence file exceeds 65536 bytes/);
  assert.deepEqual(oversized.writes, []);
});

test('audit comments contain metadata instead of protected free-form evidence', async t => {
  const f = await fixture(t, { loseCloseResponse: false });
  mergePair(f);
  const evidence = {
    schemaVersion: 1,
    summary: 'SYNTHETIC_PRIVATE_KEY_BYTES and raw source context',
    acceptance: [{ criterion: 'CONFIDENTIAL_CRITERION_TEXT', evidence: 'SYNTHETIC_PROMPT_AND_TOKEN_PAYLOAD' }],
  };
  await writeFile(f.evidenceFile, JSON.stringify(evidence));
  assert.equal((await runIssueCompletion([...f.args, '--apply'], { execute: f.execute })).status, 'COMPLETED');
  const digest = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  const comments = f.writes.filter(write => write.kind === 'comment');
  assert.equal(comments.length, 2);
  for (const comment of comments) {
    assert.doesNotMatch(comment.body, /SYNTHETIC_|CONFIDENTIAL_|raw source context/);
    assert.ok(comment.body.includes(digest));
    assert.match(comment.body, /Acceptance criteria attested: 1/);
  }
});

test('each audit comment revalidates admission after the first comment changes counterpart criteria', async t => {
  const f = await fixture(t, { changePrivateIssueAfterPublicComment: true, loseCloseResponse: false });
  mergePair(f);
  await assert.rejects(runIssueCompletion([...f.args, '--apply'], { execute: f.execute }), /changed/i);
  assert.equal(f.writes.filter(write => write.kind === 'comment').length, 1);
  assert.equal(f.writes.filter(write => write.kind === 'close').length, 0);
  assert.equal(f.publicIssue.state, 'open');
  assert.equal(f.privateIssue.state, 'open');
});
