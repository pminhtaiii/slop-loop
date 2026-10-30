import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { atomicWrite, dataDirectory, readJson, repository, withLock } from './agent-store.mjs';
import { execute, readEvidence, runIssueCompletion } from './complete-paired-issues.mjs';
import { publicationTargets } from './publication-targets.mjs';
import { resolveIssuePair } from './paired-issue-resolution.mjs';
import { issueProjectDigest } from './issue-project.mjs';

const script = fileURLToPath(import.meta.url);
const usage = 'issue-completion-job.mjs start --key <stable-key> --pr <public-PR-URL> --evidence-file <JSON> | status --key <stable-key> | resume --key <stable-key> [--root <checkout>]';
const save = (path, record) => atomicWrite(path, JSON.stringify(record, null, 2) + '\n');
const validKey = key => typeof key === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) && key.length <= 80;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function validateRecord(record, repo, key, directory) {
  if (record?.schemaVersion !== 1 || record.root !== repo.root || record.key !== key ||
      !['STARTING', 'RUNNING', 'COMPLETED', 'BLOCKED'].includes(record.status) ||
      !hash(record.evidenceSha256) || !['primary', 'submission'].every(side => hash(record.issueBodies?.[side])) ||
      !(record.projectSha256 === null || hash(record.projectSha256)) ||
      record.evidenceFile !== resolve(directory, `${key}.evidence.json`) || record.log !== resolve(directory, `${key}.log`) ||
      typeof record.pr !== 'string' || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/.test(record.pr) ||
      (record.pid !== undefined && (!Number.isSafeInteger(record.pid) || record.pid < 1))) throw new Error('Invalid completion job identity or acceptance bindings; retain and inspect its record.');
}
const completionArgs = record => ['--root', record.root, '--key', record.key, '--pr', record.pr, '--evidence-file', record.evidenceFile];

async function launch(root, key, log) {
  const fd = openSync(log, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [script, '_run', '--root', root, '--key', key], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    await new Promise((done, reject) => { child.once('error', reject); child.once('spawn', done); });
    child.unref();
    return child.pid;
  } finally { closeSync(fd); }
}

export async function runCompletionJob(root, key, dependencies = {}) {
  if (!validKey(key)) throw new Error(usage);
  const repo = await repository(root);
  const directory = await dataDirectory(repo, 'issue-completion-jobs');
  const path = resolve(directory, `${key}.json`);
  return withLock(`${path}.run.lock`, async () => {
    const record = await readJson(path);
    validateRecord(record, repo, key, directory);
    if (record.root !== repo.root || record.key !== key || record.status !== 'STARTING') throw new Error('Completion job identity or state mismatch.');
    const complete = dependencies.complete ?? runIssueCompletion;
    try {
      record.pid = process.pid;
      record.status = 'RUNNING';
      while (true) {
        if (await issueProjectDigest(repo.root) !== record.projectSha256 || (await readEvidence(record.evidenceFile)).sha256 !== record.evidenceSha256) throw new Error('Queued project configuration or evidence changed; inspect and reconcile the retained job.');
        const args = completionArgs(record);
        const options = { execute: dependencies.execute, expectedIssueBodies: record.issueBodies, expectedEvidenceSha256: record.evidenceSha256, expectedProjectSha256: record.projectSha256 };
        record.result = await complete(args, options);
        if (record.result.status === 'READY_TO_COMPLETE') record.result = await complete([...args, '--apply'], options);
        record.updatedAt = new Date().toISOString();
        if (!['WAITING_PR', 'WAITING_SUBMISSION_PR', 'WAITING_CI'].includes(record.result.status)) {
          record.status = record.result.status === 'COMPLETED' ? 'COMPLETED' : 'BLOCKED';
          break;
        }
        await save(path, record);
        await (dependencies.wait ?? (ms => new Promise(done => setTimeout(done, ms))))(60_000);
      }
    } catch (error) { record.status = 'BLOCKED'; record.error = error.message.slice(0, 2000); }
    record.updatedAt = new Date().toISOString();
    await save(path, record);
    return record;
  });
}

export async function completionJob(args, dependencies = {}) {
  const [command, ...rest] = args;
  if (!['start', 'status', 'resume', '_run'].includes(command)) throw new Error(usage);
  const { values } = parseArgs({ args: rest, options: { root: { type: 'string' }, key: { type: 'string' }, pr: { type: 'string' }, 'evidence-file': { type: 'string' } } });
  if (!validKey(values.key)) throw new Error(usage);
  const repo = await repository(values.root ?? process.cwd());
  if (command === '_run') return runCompletionJob(repo.root, values.key, dependencies);
  const directory = await dataDirectory(repo, 'issue-completion-jobs');
  const path = resolve(directory, `${values.key}.json`);
  if (command === 'status') {
    const record = await readJson(path);
    validateRecord(record, repo, values.key, directory);
    let processAlive = null;
    if (['STARTING', 'RUNNING'].includes(record.status) && record.pid) {
      try { process.kill(record.pid, 0); processAlive = true; }
      catch (error) { if (error.code === 'ESRCH') processAlive = false; else throw error; }
    }
    return { ...record, processAlive };
  }
  return withLock(`${path}.start.lock`, async () => {
    let existing;
    try { existing = await readJson(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) validateRecord(existing, repo, values.key, directory);
    if (command === 'start' && existing) {
      if (values.pr !== existing.pr || !values['evidence-file'] || (await readEvidence(values['evidence-file'])).sha256 !== existing.evidenceSha256) throw new Error('A different completion job already owns this key; retain and reconcile its evidence.');
      return existing;
    }
    let record = existing;
    if (command === 'resume') {
      if (!record || record.status === 'COMPLETED') throw new Error('No incomplete job to resume.');
      if (record.pid) {
        try { process.kill(record.pid, 0); throw new Error('Completion process may still be running; inspect before recovery.'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    } else {
      if (!values.pr || !values['evidence-file']) throw new Error(usage);
      const evidence = await readEvidence(values['evidence-file']);
      const projectSha256 = await issueProjectDigest(repo.root);
      const evidenceFile = resolve(directory, `${values.key}.evidence.json`);
      const initialArgs = ['--root', repo.root, '--key', values.key, '--pr', values.pr, '--evidence-file', resolve(values['evidence-file'])];
      const call = dependencies.execute ?? execute;
      const targets = await publicationTargets(repo, call);
      if (!targets) throw new Error('Completion jobs require paired targets.');
      const pair = await resolveIssuePair(call, repo, values, targets);
      const issueBodies = Object.fromEntries(['primary', 'submission'].map(side => [side, pair.issues[side].bodySha256]));
      const preview = await (dependencies.complete ?? runIssueCompletion)(initialArgs, { execute: dependencies.execute, expectedIssueBodies: issueBodies, expectedEvidenceSha256: evidence.sha256, expectedProjectSha256: projectSha256 });
      if (!['READY_TO_COMPLETE', 'COMPLETED', 'WAITING_PR', 'WAITING_SUBMISSION_PR', 'WAITING_CI'].includes(preview.status)) throw new Error('Completion preview is blocked; inspect before queueing.');
      await atomicWrite(evidenceFile, evidence.source);
      record = { schemaVersion: 1, key: values.key, root: repo.root, pr: values.pr, evidenceFile, evidenceSha256: evidence.sha256,
        issueBodies, projectSha256, log: resolve(directory, `${values.key}.log`), createdAt: new Date().toISOString() };
    }
    record.status = 'STARTING';
    delete record.error;
    await save(path, record);
    // The child owns status after launch; avoid overwriting a fast child's result.
    await (dependencies.launch ?? launch)(repo.root, values.key, record.log);
    return { status: 'STARTED', key: values.key, record: path, log: record.log, next: 'Yield; the local process waits for merges and CI, then closes this verified pair and updates its project item. Inspect status after interruptions.' };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  completionJob(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
