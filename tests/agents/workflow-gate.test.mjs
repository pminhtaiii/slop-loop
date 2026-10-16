import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGate } from '../../scripts/agents/workflow-gate.mjs';

test('gate progress arrives before exit and complete stdout/stderr remains in its log', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logPath = join(directory, 'gate.log');
  const events = [];
  let notifyStart;
  const started = new Promise(resolve => { notifyStart = resolve; });
  let finished = false;
  const running = runGate({ name: 'example', args: ['-e', "process.stdout.write('first\\n'); setTimeout(() => { console.error('last'); }, 100)"], cwd: directory, logPath, report: event => { events.push(event); if (event.status === 'running') notifyStart(); } }).then(result => { finished = true; return result; });
  await started;
  assert.equal(finished, false, 'start event must be visible before the command finishes');
  const result = await running;
  assert.equal(events[0].status, 'running');
  assert.equal(events.at(-1).status, 'passed');
  assert.equal(result.exitCode, 0);
  assert.match(await readFile(logPath, 'utf8'), /first[\s\S]*last/);
  assert.equal(result.log, logPath);
});

test('failed and timed-out gates retain diagnostics, exit status and bounded summaries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const timeout of [false, true]) {
    const logPath = join(directory, timeout ? 'timeout.log' : 'failure.log');
    let failure;
    try {
      await runGate({ name: 'example', args: ['-e', timeout ? "console.log('waiting');setInterval(() => {}, 1000)" : "console.error('x'.repeat(5000));process.exit(2)"], cwd: directory, logPath, timeout: timeout ? 1000 : 10000, report() {} });
    } catch (error) { failure = error; }
    assert.ok(failure);
    assert.ok(failure.message.length < 2500);
    assert.equal(failure.gate.status, timeout ? 'timed-out' : 'failed');
    assert.equal(failure.gate.exitCode, timeout ? null : 2);
    assert.match(await readFile(logPath, 'utf8'), timeout ? /"status":"timed-out"/ : /x{5000}/);
  }
});
