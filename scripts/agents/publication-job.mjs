import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { atomicWrite, dataDirectory, git, readJson, repository, withLock } from './agent-store.mjs';
import { assertNewBranch, assertNewSummary, validSummary } from './pr-conventions.mjs';
import { runWorkflow, workflowSummary } from './pr-workflow.mjs';

const script = fileURLToPath(import.meta.url);
const usage = 'publication-job.mjs start --body-file <file> --summary <action summary> [--skip-review-request] [--root <checkout>] | status --id <job UUID> [--root <checkout>]';
const jobId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unfinished = new Set(['STARTING', 'RUNNING']);
const write = (path, value) => atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
const identity = root => ({ branch: git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim(), head: git(root, ['rev-parse', 'HEAD']).stdout.trim() });

async function readBody(path) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > 65_536) throw new Error('PR body must contain 1–65536 bytes.');
    const bytes = Buffer.alloc(65_537);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (!length || length > 65_536) throw new Error('PR body must contain 1–65536 bytes.');
    return bytes.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}

export async function launchDetached(command, args, { cwd, log }) {
  const fd = openSync(log, 'ax', 0o600);
  try {
    const child = spawn(command, args, { cwd, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    await new Promise((done, reject) => { child.once('error', reject); child.once('spawn', done); });
    child.unref();
    return child.pid;
  } finally { closeSync(fd); }
}

export async function runPublicationJob(root, id, dependencies = {}) {
  if (!jobId.test(id)) throw new Error('Invalid job ID.');
  const repo = await repository(root);
  const directory = await dataDirectory(repo, 'publication-jobs');
  const path = resolve(directory, `${id}.json`);
  return withLock(`${path}.lock`, async () => {
    const record = await readJson(path);
    if (record.id !== id || record.root !== repo.root || record.status !== 'STARTING') throw new Error('Job identity or state mismatch; retain its evidence.');
    try {
      const current = identity(repo.root);
      if (current.head !== record.head || current.branch !== record.branch) throw new Error('Checkout changed since job launch; publication refused.');
      record.status = 'RUNNING'; record.pid = process.pid;
      await write(path, record);
      const args = ['publish', '--root', repo.root, '--base', 'development', '--body-file', record.bodyFile, '--summary', record.summary];
      if (record.skipReviewRequest) args.push('--skip-review-request');
      record.result = workflowSummary(await (dependencies.workflow ?? runWorkflow)(args, { expectedCandidate: { head: record.head, branch: record.branch } }));
      record.status = 'SUCCEEDED';
    } catch (error) {
      record.status = 'FAILED'; record.error = error.message.slice(0, 2000);
    }
    record.finishedAt = new Date().toISOString();
    await write(path, record);
    return record;
  });
}

export async function publicationJob(args, dependencies = {}) {
  const [command, ...options] = args;
  if (!['start', 'status'].includes(command)) throw new Error(usage);
  const names = command === 'start' ? { 'body-file': { type: 'string' }, summary: { type: 'string' }, 'skip-review-request': { type: 'boolean' } } : { id: { type: 'string' } };
  const { values } = parseArgs({ args: options, options: { root: { type: 'string' }, ...names }, allowPositionals: false });
  if (command === 'start' && (!values['body-file'] || !validSummary(values.summary))) throw new Error(usage);
  if (command === 'status' && !jobId.test(values.id ?? '')) throw new Error('Invalid job ID.');
  const repo = await repository(values.root ?? process.cwd());
  const directory = await dataDirectory(repo, 'publication-jobs');
  if (command === 'status') {
    const record = await readJson(resolve(directory, `${values.id}.json`));
    if (record.root !== repo.root || record.id !== values.id) throw new Error('Job belongs to another checkout.');
    let processAlive = null;
    if (unfinished.has(record.status) && record.pid) {
      try { process.kill(record.pid, 0); processAlive = true; }
      catch (error) { if (error.code === 'ESRCH') processAlive = false; }
    }
    return { id: record.id, status: record.status, root: record.root, branch: record.branch, head: record.head, pid: record.pid, processAlive, log: record.log, result: record.result, error: record.error, next: unfinished.has(record.status) ? 'Yield; inspect this job on resume. If its process stopped, inspect retained logs and locks before recovery.' : 'Inspect the result; successful publication still requires live PR status, app links and contributor completion.' };
  }
  const current = identity(repo.root);
  assertNewBranch(current.branch); assertNewSummary(values.summary);
  if (git(repo.root, ['status', '--porcelain', '--untracked-files=all']).stdout.trim()) throw new Error('Commit scoped changes before starting publication.');
  const body = await readBody(resolve(values['body-file']));
  const key = createHash('sha256').update(current.branch).digest('hex');
  const latest = resolve(directory, `${key}.latest.json`);
  return withLock(`${latest}.lock`, async () => {
    let previous;
    try { previous = await readJson(latest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) {
      if (!jobId.test(previous.id)) throw new Error('Invalid previous job pointer.');
      const retained = await readJson(resolve(directory, `${previous.id}.json`));
      if (unfinished.has(retained.status)) throw new Error(`Publication job ${previous.id} is unfinished; inspect it instead of launching another gate.`);
    }
    const id = randomUUID();
    const path = resolve(directory, `${id}.json`);
    const bodyFile = resolve(directory, `${id}.body.md`);
    const log = resolve(directory, `${id}.log`);
    await atomicWrite(bodyFile, body, { exclusive: true });
    const record = { id, status: 'STARTING', root: repo.root, ...current, bodyFile, summary: values.summary, skipReviewRequest: Boolean(values['skip-review-request']), log, startedAt: new Date().toISOString() };
    await write(path, record);
    await write(latest, { id });
    try {
      const pid = await (dependencies.launch ?? launchDetached)(process.execPath, [script, '--run', id, repo.root], { cwd: repo.root, log });
      return { id, status: 'STARTED', pid, root: repo.root, ...current, log, next: `Yield now. Resume with publication-job.mjs status --id ${id} --root <checkout>. No automatic agent wakeup is installed.` };
    } catch (error) {
      record.status = 'FAILED'; record.error = error.message; record.finishedAt = new Date().toISOString();
      await write(path, record);
      throw error;
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const args = process.argv.slice(2);
  const operation = args[0] === '--run' && args.length === 3 ? runPublicationJob(args[2], args[1]) : publicationJob(args);
  operation.then(result => { console.log(JSON.stringify(result, null, 2)); if (result.status === 'FAILED') process.exitCode = 1; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
