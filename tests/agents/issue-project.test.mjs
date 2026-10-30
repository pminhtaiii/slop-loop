import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { authenticatedAssignee, loadIssueProject, syncProjectItem } from '../../scripts/agents/issue-project.mjs';
import { runIssueCompletion } from '../../scripts/agents/complete-paired-issues.mjs';
import { fixture, mergePair } from './support/complete-paired-issues-fixture.mjs';
import { projectConfig, projectFixture } from './support/issue-project-fixture.mjs';

test('publication project operations preserve status and recover a lost add response', async t => {
  const f = await fixture(t);
  const p = await projectFixture(f.root, f.execute);
  const repo = { root: f.root };
  const project = await loadIssueProject(repo, p.execute);
  assert.equal(authenticatedAssignee(repo, p.execute), 'driver');
  p.state.loseAdd = true;
  assert.throws(() => syncProjectItem(repo, p.execute, project, f.privateIssue.html_url), /lost add response/);
  syncProjectItem(repo, p.execute, project, f.privateIssue.html_url);
  assert.deepEqual(p.state.writes, ['add']);
  assert.equal(p.state.items.get(f.privateIssue.html_url).fieldValueByName.optionId, 'progress');
  p.state.incomplete = true;
  assert.throws(() => syncProjectItem(repo, p.execute, project, f.privateIssue.html_url), /Incomplete/);
});

test('project identity and missing status options block before issue closure', async t => {
  const f = await fixture(t, { loseCloseResponse: false });
  mergePair(f);
  const p = await projectFixture(f.root, f.execute);
  p.state.projectId = 'PVT_replaced';
  await assert.rejects(runIssueCompletion([...f.args, '--apply'], { execute: p.execute }), /identity changed/);
  assert.deepEqual(f.writes, []);
  p.state.projectId = projectConfig.id;
  await writeFile(join(f.root, 'issue-project.json'), JSON.stringify({ ...projectConfig, doneStatus: 'Missing' }));
  await assert.rejects(runIssueCompletion([...f.args, '--apply'], { execute: p.execute }), /missing or ambiguous/);
  assert.deepEqual(f.writes, []);
});

test('preview and waiting merges make no project writes; apply confirms both issues and Done', async t => {
  const f = await fixture(t, { loseCloseResponse: false });
  const p = await projectFixture(f.root, f.execute);
  assert.equal((await runIssueCompletion([...f.args, '--apply'], { execute: p.execute })).status, 'WAITING_PR');
  mergePair(f);
  assert.equal((await runIssueCompletion(f.args, { execute: p.execute })).status, 'READY_TO_COMPLETE');
  assert.deepEqual(p.state.writes, []);
  assert.deepEqual(f.writes, []);
  assert.equal((await runIssueCompletion([...f.args, '--apply'], { execute: p.execute })).status, 'COMPLETED');
  assert.equal(f.publicIssue.state, 'closed');
  assert.equal(f.privateIssue.state, 'closed');
  assert.deepEqual(p.state.writes, ['add', 'done']);
  assert.equal((await runIssueCompletion(f.args, { execute: p.execute })).status, 'COMPLETED');
});

test('project failure after closure remains recoverable without duplicate audit comments', async t => {
  const f = await fixture(t, { loseCloseResponse: false });
  mergePair(f);
  const p = await projectFixture(f.root, f.execute);
  p.state.failEdit = true;
  await assert.rejects(runIssueCompletion([...f.args, '--apply'], { execute: p.execute }), /project edit failed/);
  assert.equal(f.privateIssue.state, 'closed');
  assert.equal((await runIssueCompletion(f.args, { execute: p.execute })).status, 'READY_TO_COMPLETE');
  p.state.failEdit = false;
  p.state.loseEdit = true;
  await assert.rejects(runIssueCompletion([...f.args, '--apply'], { execute: p.execute }), /lost edit response/);
  assert.equal((await runIssueCompletion([...f.args, '--apply'], { execute: p.execute })).status, 'COMPLETED');
  assert.equal(f.writes.filter(write => write.kind === 'comment').length, 2);
  assert.deepEqual(p.state.writes, ['add', 'done']);
});
