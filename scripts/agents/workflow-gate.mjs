import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';

export async function runGate({ name, args, cwd, logPath, timeout = 600_000, report = event => console.error(JSON.stringify(event)) }) {
  const log = await open(logPath, 'wx', 0o600);
  const started = Date.now();
  let tail = '', timedOut = false, spawnError;
  let timer;
  try {
    report({ gate: name, status: 'running', log: logPath });
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const capture = async stream => {
      for await (const chunk of stream) {
        await log.write(chunk);
        tail = (tail + chunk.toString('utf8')).slice(-2000);
      }
    };
    const closed = new Promise(resolve => {
      child.on('error', error => { spawnError = error; });
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    const [exit] = await Promise.all([closed, capture(child.stdout), capture(child.stderr)]);
    const result = { name, status: timedOut ? 'timed-out' : spawnError || exit.exitCode !== 0 ? 'failed' : 'passed', ...exit, log: logPath, durationMs: Date.now() - started, summary: tail.trim() };
    if (spawnError) await log.write(`\n${spawnError.stack ?? spawnError.message}\n`);
    await log.write(`\n[gate-result] ${JSON.stringify({ ...result, summary: undefined })}\n`);
    report({ gate: name, status: result.status, exitCode: result.exitCode, log: logPath });
    if (result.status !== 'passed') {
      const error = new Error(`Gate ${name} ${result.status}; log: ${logPath}\n${spawnError?.message ?? result.summary}`);
      error.gate = result;
      throw error;
    }
    return result;
  } finally {
    clearTimeout(timer);
    await log.close();
  }
}
