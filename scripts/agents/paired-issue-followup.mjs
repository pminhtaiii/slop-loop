import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside, repository, samePath } from './agent-store.mjs';
import { publicationTargets } from './publication-targets.mjs';
import { execute, runIssueCompletion } from './complete-paired-issues.mjs';
import { findIssue, issueMarker, validateIssueRecord } from './paired-issue-resolution.mjs';
import { completionMarker, parsePullUrl, validHash, validPrUrl, validateCompletionRecord } from './paired-issue-state.mjs';
import { sides } from './paired-issue-api.mjs';
import { featureBranch } from './pr-conventions.mjs';

const usage = 'Usage: node scripts/agents/paired-issue-followup.mjs --pr <public-PR-URL> [--key <stable-key> ...] [--evidence-file <JSON>] [--root <checkout>]';
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const keyPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const values = { keys: [] };
  const single = new Set(['pr', 'evidence-file', 'root']);
  for (let index = 0; index < args.length;) {
    const option = args[index++];
    const name = option?.slice(2);
    const value = args[index++];
    if (!option?.startsWith('--') || !value || value.startsWith('--')) throw new Error(usage);
    if (name === 'key') {
      if (!keyPattern.test(value) || value.length > 80 || values.keys.includes(value)) throw new Error('Provide each --key once as a lowercase stable slug of at most 80 characters.');
      values.keys.push(value);
    } else if (single.has(name) && !Object.hasOwn(values, name)) values[name] = value;
    else throw new Error(usage);
  }
  if (!values.pr) throw new Error(usage);
  if (values['evidence-file'] && values.keys.length !== 1) throw new Error('--evidence-file requires exactly one explicit --key.');
  return values;
}

async function localDirectory(root, path) {
  if (!inside(root, path)) throw new Error('Agent data path escapes the repository.');
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !(await samePath(path, await realpath(path)))) throw new Error('Agent data directory must be a real local directory.');
  return readdir(path);
}

async function localJson(root, directory, filename, entries) {
  if (!entries?.includes(filename)) return null;
  const path = resolve(directory, filename);
  if (!inside(directory, path)) throw new Error('Agent data file escapes its directory.');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !(await samePath(path, await realpath(path)))) throw new Error('Agent data must be a regular local file.');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function localKeys(repo) {
  const directory = resolve(repo.primary, '.agent-work', 'paired-issues');
  const entries = await localDirectory(repo.primary, directory);
  if (!entries) return [];
  return entries.filter(name => name.endsWith('.json') && keyPattern.test(name.slice(0, -5)) && name.length <= 85)
    .map(name => name.slice(0, -5)).sort();
}

async function readPair(call, repo, targets, key) {
  const marker = issueMarker(targets.primary.repository, key);
  const directory = resolve(repo.primary, '.agent-work', 'paired-issues');
  const entries = await localDirectory(repo.primary, directory);
  const record = await localJson(repo.primary, directory, `${key}.json`, entries);
  const found = Object.fromEntries(sides.map(side => [side, findIssue(call, repo, targets[side], marker)]));
  if (record) validateIssueRecord(record, key, marker, targets, found);
  if (sides.some(side => !found[side])) return null;
  return { marker, issues: found };
}

async function readCompletion(repo, targets, pair, key, publicUrl) {
  const directory = resolve(repo.primary, '.agent-work', 'paired-issue-completion');
  const entries = await localDirectory(repo.primary, directory);
  const record = await localJson(repo.primary, directory, `${key}.json`, entries);
  if (!record) return null;
  const issues = Object.fromEntries(sides.map(side => [side, { number: pair.issues[side].number, url: pair.issues[side].url }]));
  const expected = {
    schemaVersion: 1,
    key,
    issueMarker: pair.marker,
    completionMarker: completionMarker(targets.primary.repository, key),
    targets: { primary: targets.primary.repository, submission: targets.submission.repository },
    issues,
    resolvingPr: record.resolvingPr,
    evidenceSha256: record.evidenceSha256,
  };
  validateCompletionRecord(record, expected);
  const primary = record.resolvingPr?.primary;
  const submission = record.resolvingPr?.submission;
  if (!Number.isSafeInteger(primary?.number) || !validPrUrl(primary?.url, targets.primary.repository, primary.number) || primary.repository?.toLowerCase() !== targets.primary.repository.toLowerCase() || !featureBranch.test(primary.branch ?? '') || primary.base !== 'development' || !validHash(record.evidenceSha256)) throw new Error('Retained completion record has an invalid public PR identity or evidence digest.');
  if (!Number.isSafeInteger(submission?.number) || !validPrUrl(submission?.url, targets.submission.repository, submission.number) || submission.repository?.toLowerCase() !== targets.submission.repository.toLowerCase() || submission.branch !== primary.branch || submission.base !== targets.submission.base) throw new Error('Retained completion record has an invalid paired PR identity.');
  return { record, matchesPublicPr: primary.number === publicUrl.number && primary.url.toLowerCase() === publicUrl.url.toLowerCase() };
}

function completionState(record, issues) {
  const closed = sides.map(side => issues[side] === 'closed');
  if (closed.every(Boolean) && record?.progress?.primary?.closed === true && record?.progress?.submission?.closed === true) return 'COMPLETED';
  const progressed = record?.applyStarted === true || sides.some(side => ['commentIntent', 'commented', 'closeIntent', 'closed'].some(field => record?.progress?.[side]?.[field] === true));
  if (closed.some(Boolean) || (progressed && !closed.every(Boolean))) return 'RECOVER_PARTIAL';
  return record ? 'PREVIEWED' : closed.every(Boolean) ? 'CLOSED_BOTH_UNTRACKED' : 'NOT_STARTED';
}

function quotePowerShell(value) { return `'${String(value).replaceAll("'", "''")}'`; }

function completionCommand(key, publicUrl, evidenceFile, root, apply = false) {
  return [
    'node scripts/agents/complete-paired-issues.mjs',
    `--key ${key}`,
    `--pr ${quotePowerShell(publicUrl)}`,
    `--evidence-file ${evidenceFile ? quotePowerShell(evidenceFile) : '<evidence.json>'}`,
    root ? `--root ${quotePowerShell(root)}` : '',
    apply ? '--apply' : '',
  ].filter(Boolean).join(' ');
}

function statusForPreview(status) {
  if (status === 'WAITING_SUBMISSION_PR') return 'WAITING_PR';
  if (status === 'BLOCKED') return 'NOT_MET';
  return status;
}

export async function runIssueFollowup(args, dependencies = {}) {
  const values = parseArgs(args);
  if (values.help) return { usage };
  const repo = await repository(values.root ?? defaultRoot);
  const call = (binary, argv, cwd, timeout) => (dependencies.execute ?? execute)(binary, argv, cwd, timeout);
  const targets = await publicationTargets(repo, call);
  if (!targets) throw new Error('Paired issue followup requires publication-targets.json.');
  const publicUrl = parsePullUrl(values.pr, targets.primary.repository);
  const explicitKeys = values.keys.length > 0;
  const keys = explicitKeys ? values.keys : await localKeys(repo);
  const items = [];

  for (const key of keys) {
    const pair = await readPair(call, repo, targets, key);
    if (!pair) {
      items.push({ key, status: 'MISSING_ASSOCIATION', association: 'UNRESOLVED', completionState: 'UNKNOWN' });
      continue;
    }
    const issues = Object.fromEntries(sides.map(side => [side, pair.issues[side].state]));
    const issueNumbers = Object.fromEntries(sides.map(side => [side, pair.issues[side].number]));
    const retained = await readCompletion(repo, targets, pair, key, publicUrl);
    const association = retained ? retained.matchesPublicPr ? 'RETAINED' : 'MISMATCH' : explicitKeys ? 'EXPLICIT' : 'NOT_ASSERTED';
    const state = completionState(retained?.record, issues);
    const item = {
      key,
      status: 'MISSING_ASSOCIATION',
      association,
      issues,
      issueNumbers,
      completionState: state,
      acceptanceEvidence: values['evidence-file'] ? 'PROVIDED_NOT_ASSESSED' : 'MISSING',
    };

    if (association === 'MISMATCH') {
      item.status = 'ASSOCIATION_MISMATCH';
      items.push(item);
      continue;
    }
    if (state === 'COMPLETED') {
      item.status = 'COMPLETED';
      items.push(item);
      continue;
    }
    if (!explicitKeys && association !== 'RETAINED') item.status = 'MISSING_ASSOCIATION';
    else if (state === 'RECOVER_PARTIAL') item.status = 'RECOVER_PARTIAL';
    else item.status = 'MISSING_EVIDENCE';

    item.previewCommand = completionCommand(key, publicUrl.url, values['evidence-file'], values.root);
    if (item.status === 'MISSING_ASSOCIATION') item.nextStep = 'Confirm that this public PR resolves this stable key before using the preview command.';
    else if (!values['evidence-file']) item.nextStep = 'Verify every acceptance criterion and prepare its evidence file before preview.';

    if (values['evidence-file']) {
      const previewArgs = ['--key', key, '--pr', publicUrl.url, '--evidence-file', values['evidence-file']];
      if (values.root) previewArgs.push('--root', values.root);
      const preview = await runIssueCompletion(previewArgs, { execute: call });
      item.previewStatus = preview.status;
      item.status = state === 'RECOVER_PARTIAL' ? 'RECOVER_PARTIAL' : statusForPreview(preview.status);
      if (preview.status === 'READY_TO_COMPLETE') {
        item.applyCommand = completionCommand(key, publicUrl.url, values['evidence-file'], values.root, true);
        item.nextStep = 'Review the acceptance evidence yourself before running the apply command.';
      }
      if (preview.reason) item.reason = preview.reason;
      if (preview.status !== 'READY_TO_COMPLETE') delete item.applyCommand;
    }
    items.push(item);
  }

  return { status: items.length ? 'FOLLOWUP' : 'NO_CANDIDATES', publicPr: publicUrl.url, items };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runIssueFollowup(process.argv.slice(2)).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
