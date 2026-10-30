import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completionJob, runCompletionJob } from '../../scripts/agents/issue-completion-job.mjs';
import { fixture, mergePair } from './support/complete-paired-issues-fixture.mjs';
import { projectFixture } from './support/issue-project-fixture.mjs';
import { runIssueCompletion } from '../../scripts/agents/complete-paired-issues.mjs';

test('queued completion waits, closes the merged pair and confirms project Done', async t => {
  const f = await fixture(t, { loseCloseResponse: false });
  const p = await projectFixture(f.root, f.execute);
  let launches = 0;
  const dependencies = { execute: p.execute, launch: async () => { launches++; } };
  const started = await completionJob(['start', ...f.args], dependencies);
  assert.equal(started.status, 'STARTED');
  assert.deepEqual(f.writes, []);
  assert.equal((await completionJob(['start', ...f.args], dependencies)).status, 'STARTING');
  assert.equal(launches, 1);
  let waits = 0;
  const result = await runCompletionJob(f.root, 'localized-bug', { ...dependencies, wait: async ms => { assert.equal(ms, 60_000); waits++; mergePair(f); } });
  assert.equal(waits, 1);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(f.publicIssue.state, 'closed');
  assert.equal(f.privateIssue.state, 'closed');
  assert.deepEqual(p.state.writes, ['add', 'done']);
  assert.equal((await completionJob(['status', '--key', 'localized-bug', '--root', f.root])).status, 'COMPLETED');
});

test('queued acceptance drift is refused before any comment, closure or project write', async t => {
  const f = await fixture(t, { loseCloseResponse: false });
  await completionJob(['start', ...f.args], { execute: f.execute, launch: async () => {} });
  mergePair(f);
  f.privateIssue.body += '\nAn additional acceptance criterion.';
  const result = await runCompletionJob(f.root, 'localized-bug', { execute: f.execute });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.error, /acceptance changed/);
  assert.deepEqual(f.writes, []);
});

test('queued evidence and project configuration are immutable; changed inputs never apply', async t => {
  for (const changed of ['evidence', 'project']) {
    await t.test(changed, async t => {
      const f = await fixture(t, { loseCloseResponse: false });
      const started = await completionJob(['start', ...f.args], { execute: f.execute, launch: async () => {} });
      const record = JSON.parse(await readFile(started.record, 'utf8'));
      if (changed === 'evidence') {
        const evidence = JSON.parse(await readFile(record.evidenceFile, 'utf8'));
        evidence.summary = 'Substituted evidence';
        await writeFile(record.evidenceFile, JSON.stringify(evidence));
      } else await writeFile(join(f.root, 'issue-project.json'), '{}');
      mergePair(f);
      const result = await runCompletionJob(f.root, 'localized-bug', { execute: f.execute });
      assert.equal(result.status, 'BLOCKED');
      assert.match(result.error, /configuration or evidence changed/);
      assert.deepEqual(f.writes, []);
    });
  }
});

test('failed exact-head checks stop a queued job without issue writes', async t => {
  const f = await fixture(t, { loseCloseResponse: false });
  await completionJob(['start', ...f.args], { execute: f.execute, launch: async () => {} });
  mergePair(f);
  f.checks[0].conclusion = 'failure';
  const result = await runCompletionJob(f.root, 'localized-bug', { execute: f.execute });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(f.writes, []);
});

test('start rejects substitution of a queued resolving PR or acceptance evidence', async t => {
  const f = await fixture(t);
  const dependencies = { execute: f.execute, launch: async () => {} };
  await completionJob(['start', ...f.args], dependencies);
  const replaced = f.args.map(arg => arg === f.prs.primary.url ? 'https://github.com/example/public/pull/8' : arg);
  await assert.rejects(completionJob(['start', ...replaced], dependencies), /different completion job/);
  assert.deepEqual(f.writes, []);
});

test('queue admission pins acceptance before preview rather than adopting changed criteria afterward', async t => {
  const f = await fixture(t, { loseCloseResponse: false });
  await completionJob(['start', ...f.args], { execute: f.execute, launch: async () => {}, complete: async (args, options) => {
    const result = await runIssueCompletion(args, options);
    f.privateIssue.body += '\nNew criterion after preview.';
    return result;
  } });
  mergePair(f);
  const result = await runCompletionJob(f.root, 'localized-bug', { execute: f.execute });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.error, /acceptance changed/);
  assert.deepEqual(f.writes, []);
});

test('missing persisted acceptance bindings cannot disable drift checks', async t => {
  const f = await fixture(t);
  const started = await completionJob(['start', ...f.args], { execute: f.execute, launch: async () => {} });
  const record = JSON.parse(await readFile(started.record, 'utf8'));
  delete record.issueBodies;
  await writeFile(started.record, JSON.stringify(record));
  mergePair(f);
  await assert.rejects(runCompletionJob(f.root, 'localized-bug', { execute: f.execute }), /Invalid completion job/);
  assert.deepEqual(f.writes, []);
});

test('evidence or project substitution between ready preview and apply cannot close issues', async t => {
  for (const changed of ['evidence', 'project']) {
    await t.test(changed, async t => {
      const f = await fixture(t, { loseCloseResponse: false });
      const started = await completionJob(['start', ...f.args], { execute: f.execute, launch: async () => {} });
      const record = JSON.parse(await readFile(started.record, 'utf8'));
      mergePair(f);
      const result = await runCompletionJob(f.root, 'localized-bug', { execute: f.execute, complete: async (args, options) => {
        const preview = await runIssueCompletion(args, options);
        if (preview.status === 'READY_TO_COMPLETE' && !args.includes('--apply')) {
          if (changed === 'evidence') {
            const evidence = JSON.parse(await readFile(record.evidenceFile, 'utf8'));
            evidence.summary = 'Replacement evidence after preview';
            await writeFile(record.evidenceFile, JSON.stringify(evidence));
          } else await writeFile(join(f.root, 'issue-project.json'), '{}');
        }
        return preview;
      } });
      assert.equal(result.status, 'BLOCKED');
      assert.match(result.error, changed === 'evidence' ? /evidence changed/ : /configuration changed/);
      assert.deepEqual(f.writes, []);
    });
  }
});
