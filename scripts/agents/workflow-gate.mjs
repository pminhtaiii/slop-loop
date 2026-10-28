import { spawn, spawnSync } from 'node:child_process';
import { open } from 'node:fs/promises';
import { createGateProgressParser } from './workflow-gate-progress.mjs';

const PROGRESS_INTERVAL_MS = 30_000;
const MAX_PROGRESS_EVENTS = 500;

function defaultTimeout() {
  const timeout = Number(process.env.WORKFLOW_GATE_TIMEOUT);
  return Number.isInteger(timeout) && timeout > 0 && timeout <= 2_147_483_647 ? timeout : 1_200_000;
}

export function packageScriptCommand(script, platform = process.platform) {
  if (typeof script !== 'string' || !/^[a-zA-Z0-9:_-]+$/.test(script)) throw new Error('Invalid package script name.');
  return platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', `pnpm run ${script}`] }
    : { command: 'pnpm', args: ['run', script] };
}

export async function runGate({ name, command = process.execPath, args, cwd, logPath, timeout = defaultTimeout(), progress = name === 'tests', report = event => console.error(JSON.stringify(event)) }) {
  const log = await open(logPath, 'wx', 0o600);
  const started = Date.now();
  let tail = '', timedOut = false, spawnError, terminationError;
  let timer, heartbeat;
  const progressEnabled = progress === true;
  const progressParser = progressEnabled ? createGateProgressParser() : null;
  const progressState = { lastProgressAt: new Date(started).toISOString(), currentTest: null, currentFile: null, testEvent: null };
  let reportedProgressEvents = 0;
  const progressFields = (at = Date.now()) => ({
    startedAt: new Date(started).toISOString(),
    lastProgressAt: progressState.lastProgressAt,
    elapsedMs: Math.max(0, at - started),
    timeoutMs: timeout,
    currentTest: progressState.currentTest,
    currentFile: progressState.currentFile,
    ...(progressState.testEvent ? { testEvent: progressState.testEvent } : {}),
  });
  const progressEvent = (status, at = Date.now()) => ({ gate: name, status, ...progressFields(at), log: logPath });
  const acceptProgress = events => {
    for (const event of events) {
      const at = Date.now();
      Object.assign(progressState, {
        lastProgressAt: new Date(at).toISOString(),
        currentTest: event.currentTest,
        currentFile: event.currentFile,
        testEvent: event.testEvent,
      });
      if (reportedProgressEvents < MAX_PROGRESS_EVENTS) {
        reportedProgressEvents += 1;
        report(progressEvent('progress', at));
      }
    }
  };
  try {
    report(progressEnabled ? progressEvent('running', started) : { gate: name, status: 'running', log: logPath });
    const child = spawn(command, args, { cwd, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(progressEnabled ? { env: { ...process.env, WORKFLOW_GATE_PROGRESS: '1' } } : {}) });
    const capture = async (stream, parseProgress = false) => {
      for await (const chunk of stream) {
        await log.write(chunk);
        tail = (tail + chunk.toString('utf8')).slice(-2000);
        if (parseProgress) acceptProgress(progressParser.write(chunk));
      }
      if (parseProgress) acceptProgress(progressParser.end());
    };
    const closed = new Promise(resolve => {
      child.on('error', error => { spawnError = error; });
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    timer = setTimeout(() => {
      timedOut = true;
      if (!child.pid) return;
      // Gates own this process tree; nested pnpm/test commands must stop with it.
      if (process.platform === 'win32') {
        const stopped = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 10_000 });
        if (stopped.error || stopped.status !== 0) { terminationError = stopped.error?.message ?? stopped.stderr; child.kill(); }
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') { terminationError = error.message; child.kill('SIGKILL'); } }
      }
    }, timeout);
    if (progressEnabled) heartbeat = setInterval(() => report(progressEvent('heartbeat')), PROGRESS_INTERVAL_MS);
    const [exit] = await Promise.all([closed, capture(child.stdout), capture(child.stderr, progressEnabled)]);
    const result = { name, status: timedOut ? 'timed-out' : spawnError || exit.exitCode !== 0 ? 'failed' : 'passed', ...exit, log: logPath, durationMs: Date.now() - started, summary: tail.trim(), terminationError, ...(progressEnabled ? progressFields() : {}) };
    if (spawnError) await log.write(`\n${spawnError.stack ?? spawnError.message}\n`);
    await log.write(`\n[gate-result] ${JSON.stringify({ ...result, summary: undefined })}\n`);
    report({ gate: name, status: result.status, exitCode: result.exitCode, log: logPath, ...(progressEnabled ? progressFields() : {}) });
    if (result.status !== 'passed') {
      const error = new Error(`Gate ${name} ${result.status}; log: ${logPath}\n${spawnError?.message ?? result.summary}`);
      error.gate = result;
      throw error;
    }
    return result;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    clearTimeout(timer);
    await log.close();
  }
}
