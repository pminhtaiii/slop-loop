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
    if (timeout) assert.notEqual(failure.gate.exitCode, 0, 'termination preserves the platform exit status');
    else assert.equal(failure.gate.exitCode, 2);
    assert.match(await readFile(logPath, 'utf8'), timeout ? /"status":"timed-out"/ : /x{5000}/);
  }
});

test('gate timeout terminates descendants inheriting its output pipes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-gate-tree-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(() => {}, 6000)'],{stdio:['ignore','inherit','inherit']});require('node:fs').writeFileSync('descendant.pid',String(child.pid));setTimeout(() => {},6000);";
  const started = Date.now();
  await assert.rejects(runGate({ name: 'nested', args: ['-e', script], cwd: directory, logPath: join(directory, 'nested.log'), timeout: 1500, report() {} }), /timed-out/);
  const pid = Number(await readFile(join(directory, 'descendant.pid'), 'utf8'));
  t.after(() => { try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'descendant must not survive a gate timeout');
  assert.ok(Date.now() - started < 5000, 'timeout must not wait for inherited pipes from surviving descendants');
});
