import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repository } from './agent-store.mjs';
import { runWorkflow } from './pr-workflow.mjs';

const taskCli = resolve(dirname(fileURLToPath(import.meta.url)), 'active-task.mjs');
const usage = 'Usage: contributor-prepare.mjs [--root <checkout>] [--next-branch <feat/scope-description>] [--register --owner <id> --task <id> --session <date/id> --summary <text> --next <text> --owned-path <path>... [--factory-managed]]';
const options = new Set(['root', 'next-branch', 'register', 'owner', 'task', 'session', 'summary', 'next', 'owned-path', 'role', 'factory-managed']);

function parse(values) {
  const parsed = { ownedPaths: [] };
  for (let index = 0; index < values.length;) {
    const name = values[index].startsWith('--') ? values[index].slice(2) : '';
    if (!options.has(name)) throw new Error(usage);
    if (['register', 'factory-managed'].includes(name)) {
      if (parsed[name]) throw new Error(usage);
      parsed[name] = true;
      index += 1;
      continue;
    }
    const value = values[index + 1];
    if (!value || value.startsWith('--')) throw new Error(usage);
    if (name === 'owned-path') parsed.ownedPaths.push(value);
    else if (Object.hasOwn(parsed, name)) throw new Error(usage);
    else parsed[name] = value;
    index += 2;
  }
  if (parsed.role && parsed.role !== 'worker') throw new Error('--role must be worker.');
  if (parsed['factory-managed'] && !parsed.register) throw new Error('--factory-managed requires --register.');
  if (parsed.register && (!parsed.owner || !parsed.task || !parsed.session || !parsed.summary || !parsed.next || !parsed.ownedPaths.length)) throw new Error(`--register requires --owner, --task, --session, --summary, --next, and at least one --owned-path.\n${usage}`);
  return parsed;
}

function execute(binary, args, cwd, timeout = 15_000) {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `${binary} failed (${result.status})`);
  return result.stdout.trim();
}

function remoteName(url) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  if (!match) throw new Error('origin must identify a GitHub repository over HTTPS or SSH.');
  return match[1];
}

async function environment(root, call) {
  const node = { available: true, version: process.version };
  let git, gh;
  try { git = { available: true, version: call('git', ['--version'], root) }; }
  catch { git = { available: false }; }
  try {
    const version = call('gh', ['--version'], root).split('\n')[0];
    let authenticated = 'unknown';
    try { call('gh', ['auth', 'status', '--hostname', 'github.com'], root); authenticated = true; }
    catch { authenticated = 'unknown'; }
    gh = { available: true, version, authenticated };
  } catch { gh = { available: false, authenticated: 'unknown' }; }
  return { node, git, gh, model: 'unknown', sandbox: 'unknown' };
}

function dirtyPaths(dirty) {
  return String(dirty ?? '').split(/\r?\n/).filter(Boolean).map(line => line.slice(3).trim()).filter(Boolean);
}

function nextCommand(status, root, branch, nextBranch, pr) {
  if (status === 'NEEDS_NEXT_BRANCH') return { command: 'node', args: ['scripts/agents/pr-workflow.mjs', 'prepare-next', '--root', root, '--branch', nextBranch ?? 'feat/<scope-description>'] };
  if (status === 'BLOCKED' && pr.state === 'CLOSED' && pr.number) return { command: 'gh', args: ['pr', 'view', String(pr.number), '--repo', pr.repository] };
  if (status === 'BLOCKED') return { command: 'node', args: ['scripts/agents/pr-workflow.mjs', 'preflight', '--root', root] };
  return { command: 'node', args: ['scripts/agents/contributor-prepare.mjs', '--root', root, '--register', '--owner', '<id>', '--task', '<id>', '--session', '<date/id>', '--summary', '<text>', '--next', '<text>', '--owned-path', '<path>'] };
}

function livePullRequest(repo, branch, localHead, call) {
  const repositoryName = remoteName(call('git', ['remote', 'get-url', 'origin'], repo.root));
  const rows = JSON.parse(call('gh', ['pr', 'list', '--repo', repositoryName, '--head', branch, '--state', 'all', '--json', 'number,state,mergedAt,url,headRefName,baseRefName,headRefOid'], repo.root));
  if (!Array.isArray(rows) || rows.some(pr => !pr || typeof pr.headRefName !== 'string')) throw new Error('Live PR lookup returned an invalid list.');
  const current = rows.filter(pr => pr.headRefName === branch);
  if (current.length !== rows.length) throw new Error('Live PR lookup returned a different branch identity.');
  if (current.length > 1) throw new Error('More than one live or closed PR is recorded for this branch.');
  if (!current.length) return { pullRequest: { state: 'NONE', number: null, url: null, repository: repositoryName }, blocker: null };

  const pr = current[0];
  if (!Number.isInteger(pr.number) || !['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) || pr.baseRefName !== 'development') throw new Error('Live PR identity or base is incomplete; inspect it before editing.');
  const pullRequest = { state: pr.mergedAt ? 'MERGED' : pr.state, number: pr.number, url: pr.url ?? null, repository: repositoryName, head: pr.headRefOid ?? null, base: pr.baseRefName };
  if (pullRequest.state !== 'OPEN') return { pullRequest, blocker: null };

  const commit = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;
  if (typeof pr.headRefOid !== 'string' || !commit.test(pr.headRefOid)) return { pullRequest, blocker: 'The live PR head SHA is missing or invalid; inspect the PR before editing.' };
  if (typeof localHead !== 'string' || !commit.test(localHead)) return { pullRequest, blocker: 'The prepared checkout HEAD SHA is missing or invalid; rerun preparation after repairing the checkout.' };
  let mergeBase;
  try { mergeBase = call('git', ['merge-base', pr.headRefOid, localHead], repo.root); }
  catch { return { pullRequest, blocker: 'The live PR head is unavailable in the prepared checkout; update or fetch the feature branch and rerun preparation.' }; }
  if (mergeBase.toLowerCase() !== pr.headRefOid.toLowerCase()) return { pullRequest, blocker: 'The live PR head is not contained in the prepared checkout; update the feature branch and rerun preparation.' };
  return { pullRequest, blocker: null };
}

function samePullRequest(first, second) {
  return first.state === second.state && first.number === second.number && first.repository === second.repository && first.base === second.base;
}

async function registerWorker(values, repo, branch, head, previousPullRequest, call) {
  let currentBranch, currentHead, dirty;
  try {
    currentBranch = call('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], repo.root);
    currentHead = call('git', ['rev-parse', '--verify', 'HEAD'], repo.root);
    dirty = call('git', ['status', '--porcelain', '--untracked-files=all'], repo.root);
  } catch (error) {
    return { status: 'BLOCKED', pullRequest: previousPullRequest, registered: false, blocker: `Could not recheck the checkout before registration: ${error.message}` };
  }
  if (currentBranch !== branch || currentHead !== head || dirty) return { status: 'BLOCKED', pullRequest: previousPullRequest, registered: false, blocker: 'Checkout changed after preparation; rerun without registering.' };
  let latest;
  try { latest = livePullRequest(repo, branch, head, call); }
  catch (error) { return { status: 'BLOCKED', pullRequest: { state: 'UNKNOWN', number: null, url: null, repository: null }, registered: false, blocker: error.message }; }
  const latestPullRequest = latest.pullRequest;
  if (latestPullRequest.state === 'MERGED') return { status: 'NEEDS_NEXT_BRANCH', pullRequest: latestPullRequest, registered: false, blocker: 'The current feature branch merged during preparation; prepare a fresh branch before follow-up edits.' };
  if (latestPullRequest.state === 'CLOSED') return { status: 'BLOCKED', pullRequest: latestPullRequest, registered: false, blocker: 'The recorded PR closed during preparation; inspect it before editing.' };
  if (!samePullRequest(previousPullRequest, latestPullRequest)) return { status: 'BLOCKED', pullRequest: latestPullRequest, registered: false, blocker: 'Live PR identity, state, or base changed during preparation; inspect it and rerun preparation.' };
  if (latest.blocker) return { status: 'BLOCKED', pullRequest: latestPullRequest, registered: false, blocker: latest.blocker };
  const args = [taskCli, 'start', '--root', repo.root, '--role', 'worker', '--owner', values.owner, '--task', values.task, '--session', values.session, '--summary', values.summary, '--next', values.next];
  for (const path of values.ownedPaths) args.push('--owned-path', path);
  args.push('--expected-branch', branch, '--expected-head', head, '--require-clean');
  if (values['factory-managed']) args.push('--factory-managed');
  let startError;
  try { call(process.execPath, args, repo.root, 30_000); }
  catch (error) { startError = error; }
  let entries;
  try {
    entries = JSON.parse(await readFile(resolve(repo.primary, '.agent-work/state/active-tasks.json'), 'utf8'));
    if (!Array.isArray(entries)) throw new Error('Registry is not a JSON array.');
  } catch (error) {
    return { status: 'BLOCKED', pullRequest: latestPullRequest, registered: null, blocker: `Active-task start was attempted, but its registry could not be inspected (${error.message}); inspect the registry before retrying.` };
  }
  const matches = entries.filter(entry => entry?.owner === values.owner && entry?.task === values.task);
  if (!matches.length) return { status: 'BLOCKED', pullRequest: latestPullRequest, registered: false, blocker: startError?.message ?? 'Active-task start returned without recording a worker assignment.' };
  const entry = matches[0];
  const matchesPreparedCheckout = matches.length === 1 && entry.role === 'worker' && entry.session === values.session && entry.status === 'active' && entry.binding?.branch === `refs/heads/${branch}` && entry.binding?.base?.sha === head;
  if (!matchesPreparedCheckout) return { status: 'BLOCKED', pullRequest: latestPullRequest, registered: true, entry, blocker: 'A worker assignment exists but does not match the prepared checkout; inspect the active-task registry and recover it before proceeding. No assignment was removed.' };
  let finalBranch, finalHead, finalDirty;
  try {
    finalBranch = call('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], repo.root);
    finalHead = call('git', ['rev-parse', '--verify', 'HEAD'], repo.root);
    finalDirty = call('git', ['status', '--porcelain', '--untracked-files=all'], repo.root);
  } catch (error) {
    return { status: 'BLOCKED', pullRequest: latestPullRequest, registered: true, entry, blocker: `Worker registration exists, but the checkout could not be reverified (${error.message}); inspect the active-task registry before proceeding.` };
  }
  if (finalBranch !== branch || finalHead !== head || finalDirty) return { status: 'BLOCKED', pullRequest: latestPullRequest, registered: true, entry, blocker: 'Worker registration exists, but the checkout changed after registration; inspect the active-task registry and recover the checkout before proceeding. No assignment was removed.' };
  if (startError) return { status: 'BLOCKED', pullRequest: latestPullRequest, registered: true, entry, blocker: `Active-task start returned an error after recording the worker assignment (${startError.message}); inspect the registry before proceeding.` };
  return { status: 'READY', pullRequest: latestPullRequest, registered: true, entry };
}

export async function contributorPrepare(args, dependencies = {}) {
  const values = parse(args);
  const repo = await repository(resolve(values.root ?? process.cwd()));
  const call = dependencies.execute ?? execute;
  let preflight;
  try { preflight = await runWorkflow(['preflight', '--root', repo.root], { execute: call }); }
  catch (error) {
    const environmentState = await environment(repo.root, call);
    return {
      schemaVersion: 1,
      status: 'BLOCKED',
      checkout: { root: repo.root, branch: null, head: null, base: null, behind: null, ahead: null, dirty: false, dirtyPaths: [] },
      pullRequest: { state: 'UNKNOWN', number: null, url: null, repository: null },
      assignment: { role: values.register ? 'worker' : 'unassigned', registered: false, session: values.session ?? null, owner: values.owner ?? null, task: values.task ?? null },
      context: { navigation: 'context/active_task.md', workflow: 'context/workflow.md', task: values.task ? `active-task:${values.owner}/${values.task}` : null, freshness: 'unknown' },
      environment: environmentState,
      blockers: [error.message],
      nextCommand: { command: 'node', args: ['scripts/agents/pr-workflow.mjs', 'preflight', '--root', repo.root] },
    };
  }

  const environmentState = await environment(repo.root, call);
  const paths = dirtyPaths(preflight.dirty);
  const checkout = { root: repo.root, branch: preflight.branch, head: preflight.head, base: preflight.base, behind: preflight.behind, ahead: preflight.ahead, dirty: paths.length > 0, dirtyPaths: paths };
  const assignment = { role: values.register ? 'worker' : 'unassigned', registered: false, session: values.session ?? null, owner: values.owner ?? null, task: values.task ?? null };
  const context = { navigation: 'context/active_task.md', workflow: 'context/workflow.md', task: values.task ? `active-task:${values.owner}/${values.task}` : null, freshness: preflight.behind > 0 ? 'behind-development' : 'current-with-development' };
  const blockers = [...preflight.blockers];
  let pullRequest = { state: 'UNKNOWN', number: null, url: null, repository: null };
  let pullRequestBlocker = null;
  if (preflight.branch) {
    try {
      ({ pullRequest, blocker: pullRequestBlocker } = livePullRequest(repo, preflight.branch, preflight.head, call));
      if (pullRequestBlocker) blockers.push(pullRequestBlocker);
    } catch (error) {
      pullRequest = { state: 'UNKNOWN', number: null, url: null, repository: null };
      blockers.push(error.message);
    }
  }
  let status = preflight.status === 'READY_TO_WORK' && pullRequest.state !== 'UNKNOWN' && !pullRequestBlocker ? 'READY' : 'BLOCKED';
  if (pullRequest.state === 'MERGED') status = 'NEEDS_NEXT_BRANCH';
  if (pullRequest.state === 'CLOSED') { status = 'BLOCKED'; blockers.push('The recorded PR is closed but not merged; inspect it before editing.'); }
  if (status === 'NEEDS_NEXT_BRANCH') blockers.push('The current feature branch has merged; prepare a fresh branch before follow-up edits.');
  const report = {
    schemaVersion: 1,
    status,
    checkout,
    pullRequest,
    assignment,
    context,
    environment: environmentState,
    blockers,
    nextCommand: nextCommand(status, repo.root, preflight.branch, values['next-branch'], pullRequest),
  };
  if (status === 'READY' && values.register) {
    const registration = await registerWorker(values, repo, preflight.branch, preflight.head, pullRequest, call);
    report.status = registration.status;
    report.pullRequest = registration.pullRequest;
    if (registration.blocker) report.blockers.push(registration.blocker);
    const entry = registration.entry;
    report.assignment = entry
      ? { role: entry.role ?? 'worker', registered: registration.registered, session: entry.session ?? null, owner: entry.owner ?? values.owner, task: entry.task ?? values.task, binding: entry.binding ?? null }
      : { role: 'worker', registered: registration.registered, session: values.session, owner: values.owner, task: values.task };
    if (registration.registered !== false) report.nextCommand = { command: 'node', args: ['scripts/agents/active-task.mjs', 'list', '--root', repo.root, '--owner', values.owner, '--task', values.task] };
    else report.nextCommand = nextCommand(report.status, repo.root, preflight.branch, values['next-branch'], report.pullRequest);
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  contributorPrepare(process.argv.slice(2)).then(report => {
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'READY') process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
