import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageScriptCommand, runGate } from '../../scripts/agents/workflow-gate.mjs';

test('package script gates run the same pnpm command on Unix and Windows', () => {
  assert.deepEqual(packageScriptCommand('test:contributors', 'linux'), { command: 'pnpm', args: ['run', 'test:contributors'] });
  assert.deepEqual(packageScriptCommand('test:contributors', 'win32'), { command: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm run test:contributors'] });
  assert.throws(() => packageScriptCommand('test:contributors && whoami', 'linux'), /package script/);
});

test('gate accepts only bounded positive integer environment timeouts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-gate-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.WORKFLOW_GATE_TIMEOUT;
  t.after(() => {
    if (previous === undefined) delete process.env.WORKFLOW_GATE_TIMEOUT;
    else process.env.WORKFLOW_GATE_TIMEOUT = previous;
  });
  const delays = [];
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    delays.push(delay);
    return schedule(callback, 10_000, ...args);
  });
  const cases = [
    [undefined, 1_200_000], ['', 1_200_000], ['invalid', 1_200_000],
    ['0', 1_200_000], ['-1', 1_200_000], ['1.5', 1_200_000],
    ['Infinity', 1_200_000], ['-Infinity', 1_200_000],
    ['2147483648', 1_200_000], ['1e100', 1_200_000],
    ['1', 1], ['600000', 600_000], ['2147483647', 2_147_483_647],
  ];
  for (const [index, [value, expected]] of cases.entries()) {
    if (value === undefined) delete process.env.WORKFLOW_GATE_TIMEOUT;
    else process.env.WORKFLOW_GATE_TIMEOUT = value;
    await runGate({ name: 'env', args: ['-e', ''], cwd: directory, logPath: join(directory, `${index}.log`), report() {} });
    assert.equal(delays.at(-1), expected, `environment timeout: ${value}`);
  }
  process.env.WORKFLOW_GATE_TIMEOUT = '-1';
  await runGate({ name: 'explicit', args: ['-e', ''], cwd: directory, logPath: join(directory, 'explicit.log'), timeout: 1234, report() {} });
  assert.equal(delays.at(-1), 1234, 'explicit timeout takes precedence');
});

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

test('managed gates report bounded test progress and clean their heartbeat timer', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-gate-progress-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  const intervalDelays = [];
  const cleared = [];
  const setInterval = globalThis.setInterval;
  const clearInterval = globalThis.clearInterval;
  t.mock.method(globalThis, 'setInterval', (callback, delay, ...args) => {
    intervalDelays.push(delay);
    return setInterval(callback, 10, ...args);
  });
  t.mock.method(globalThis, 'clearInterval', timer => {
    cleared.push(timer);
    return clearInterval(timer);
  });

  const line = '@@workflow-gate-progress ' + JSON.stringify({ type: 'test:start', test: 'fixture test', file: 'tests/fake.test.mjs' }) + '\n';
  const script = `if(process.env.WORKFLOW_GATE_PROGRESS!=='1')process.exitCode=5;const b=Buffer.from(${JSON.stringify(line)});process.stderr.write('visible stderr\\n');setTimeout(()=>process.stdout.write('visible stdout\\n'),20);process.stderr.write(b.subarray(0,11));setTimeout(()=>process.stderr.write(b.subarray(11)),5);setTimeout(()=>{},45);`;
  const logPath = join(directory, 'managed.log');
  const result = await runGate({ name: 'tests', args: ['-e', script], cwd: directory, logPath, timeout: 5000, report: event => events.push(event) });

  assert.equal(result.status, 'passed');
  assert.deepEqual(intervalDelays, [30_000]);
  assert.equal(cleared.length, 1);
  assert.equal(events[0].status, 'running');
  assert.ok(events.some(event => event.status === 'progress'));
  assert.ok(events.some(event => event.status === 'heartbeat'));
  assert.equal(events.at(-1).status, 'passed');
  const progress = events.find(event => event.status === 'progress');
  assert.equal(progress.testEvent, 'test:start');
  assert.equal(progress.currentTest, 'fixture test');
  assert.equal(progress.currentFile, 'tests/fake.test.mjs');
  assert.equal(progress.timeoutMs, 5000);
  assert.ok(Number.isFinite(Date.parse(progress.startedAt)));
  assert.ok(Number.isFinite(Date.parse(progress.lastProgressAt)));
  assert.ok(progress.elapsedMs >= 0);
  assert.equal(events.at(-1).timeoutMs, 5000);
  assert.equal(events.at(-1).currentTest, 'fixture test');
  assert.equal(events.at(-1).lastProgressAt, progress.lastProgressAt);
  assert.ok(events.at(-1).elapsedMs >= progress.elapsedMs);
  assert.doesNotMatch(JSON.stringify(events), /visible stdout|visible stderr/);
  // Pipe scheduling permits either arrival order; require both visible outputs.
  const log = await readFile(logPath, 'utf8');
  assert.match(log, /visible stdout/);
  assert.match(log, /visible stderr/);
});

test('progress heartbeats do not extend the finite gate watchdog', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-gate-progress-timeout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const timeoutMs = 150;
  const setInterval = globalThis.setInterval;
  const clearInterval = globalThis.clearInterval;
  const setTimeout = globalThis.setTimeout;
  const cleared = [];
  const timeoutDelays = [];
  let watching = false;
  t.mock.method(globalThis, 'setInterval', (callback, delay, ...args) => setInterval(callback, 10, ...args));
  t.mock.method(globalThis, 'clearInterval', timer => { cleared.push(timer); return clearInterval(timer); });
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (watching) timeoutDelays.push(delay);
    return setTimeout(callback, delay, ...args);
  });
  const events = [];
  let failure;
  const logPath = join(directory, 'timeout.log');
  try {
    await runGate({
      name: 'tests',
      args: ['-e', 'setInterval(() => {}, 1000);setTimeout(() => process.exit(0), 5000)'],
      cwd: directory,
      logPath,
      timeout: timeoutMs,
      report: event => {
        events.push(event);
        if (event.status === 'running') watching = true;
        if (['passed', 'failed', 'timed-out'].includes(event.status)) watching = false;
      },
    });
  } catch (error) { failure = error; }
  assert.ok(failure);
  assert.equal(failure.gate.status, 'timed-out');
  assert.equal(failure.gate.timeoutMs, timeoutMs);
  assert.deepEqual(timeoutDelays, [timeoutMs], 'heartbeats keep one finite watchdog deadline');
  assert.ok(events.some(event => event.status === 'heartbeat'), 'the child stays alive long enough to emit heartbeats');
  assert.notEqual(failure.gate.exitCode, 0, 'the timeout terminates the child instead of accepting its result');
  assert.equal(cleared.length, 1);
  assert.equal(events.at(-1).status, 'timed-out');
  assert.match(await readFile(logPath, 'utf8'), /"status":"timed-out"/);
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
  const script = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',\"setInterval(() => require('node:fs').appendFileSync('heartbeat','x'),50);setTimeout(() => process.exit(),60000)\"],{stdio:['ignore','inherit','inherit']});require('node:fs').writeFileSync('descendant.pid',String(child.pid));setTimeout(() => {},60000);";
  const started = Date.now();
  await assert.rejects(runGate({ name: 'nested', args: ['-e', script], cwd: directory, logPath: join(directory, 'nested.log'), timeout: 1500, report() {} }), /timed-out/);
  const pid = Number(await readFile(join(directory, 'descendant.pid'), 'utf8'));
  t.after(() => { try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  if (process.platform === 'win32') assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'descendant must not survive a gate timeout');
  const heartbeat = () => readFile(join(directory, 'heartbeat'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const stopped = await heartbeat();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await heartbeat(), stopped, 'descendant activity stops, even while POSIX waits to reap a zombie PID');
  assert.ok(Date.now() - started < 20000, 'timeout must not wait for inherited pipes from surviving descendants');
});
