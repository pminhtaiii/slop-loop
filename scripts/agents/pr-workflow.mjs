import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { runGate } from './workflow-gate.mjs';
import { publicationTargets } from './publication-targets.mjs';
import { inspectSubmissionTarget, publishSubmission, verifySubmission } from './submission-pr.mjs';
import { assertNoTrackedArtifacts } from '../ci/check-tracked-files.mjs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, dataDirectory, readJson, repository, withLock } from './agent-store.mjs';

const checksRequired = ['contributor-checks (ubuntu-latest)', 'contributor-checks (windows-latest)', 'runtime-checks (ubuntu-latest)', 'runtime-checks (windows-latest)'];
const featureName = /^feat\/\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const maxRepairs = 3;
const usage = `Usage: node scripts/agents/pr-workflow.mjs <preflight|publish|status|ready|repair|watch|record-app-state|complete|prepare-next> [--root <checkout>]
preflight fetches origin/development and reports freshness, naming, dirty paths, and diff size; it never publishes.
publish requires --body-file <file> and --summary <short summary>; optional --base development.
repair requires --reason <diagnosed finding>. At most three repair rounds per PR.
record-app-state requires --receipt <app list_thread_pull_requests JSON>.
prepare-next --branch feat/NNN-description creates a fresh branch from fetched development after this branch's recorded PR merges; source branches and worktrees are retained.
complete verifies clean published current-head work, linked PR evidence and passing CI; it never merges.
watch polls for at most ten minutes, stopping for fixes, human approval, or timeout.
Configured paired publication also opens a submission PR with the same source tree and separate submission ancestry.
The helper never merges, force-pushes, or resolves review threads.`;

function validSummary(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 80 && value === value.trim() && !/[\r\n]/.test(value);
}

export function assess({ head, pr, checks }) {
  const result = { status: 'WAITING_CI', failedChecks: [], unresolved: [] };
  const titlePrefix = `${pr.headRefName}: `;
  if (pr.state !== 'OPEN' || pr.headRefOid !== head || !featureName.test(pr.headRefName) || !pr.title.startsWith(titlePrefix) || !validSummary(pr.title.slice(titlePrefix.length)) || pr.baseRefName !== 'development') return { ...result, status: 'BLOCKED', reason: 'PR identity, title, base, state, or current HEAD does not match.' };
  if (pr.reviews.pageInfo.hasPreviousPage || pr.reviewThreads.pageInfo.hasNextPage) return { ...result, status: 'BLOCKED', reason: 'Review data exceeds the bounded page; inspect manually.' };
  result.unresolved = pr.reviewThreads.nodes.filter((thread) => !thread.isResolved);
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'BEHIND') return { ...result, status: 'BLOCKED', reason: 'Update the feature branch against development and rerun verification.' };
  const latest = checksRequired.map((name) => checks.filter((check) => check.name === name && check.head_sha === head && check.app?.slug === 'github-actions').sort((a, b) => b.id - a.id)[0]);
  result.failedChecks = latest.filter((check) => check?.status === 'completed' && check.conclusion !== 'success').map((check) => ({ name: check.name, conclusion: check.conclusion, url: check.details_url }));
  if (result.failedChecks.length) result.status = 'NEEDS_FIX';
  else if (pr.mergeable === 'UNKNOWN' || latest.some((check) => !check || check.status !== 'completed')) result.status = 'WAITING_CI';
  else if (pr.mergeStateStatus === 'BLOCKED' && pr.isDraft === false) return { ...result, status: 'BLOCKED', reason: 'GitHub reports an unmet merge requirement.' };
  else result.status = pr.isDraft === false ? 'AWAITING_HUMAN_MERGE' : 'READY_FOR_HUMAN';
  return result;
}

export function changedLines(numstat) {
  let reviewable = 0, generated = 0, binaries = 0;
  for (const line of numstat.trim().split('\n').filter(Boolean)) {
    const [added, removed, ...path] = line.split('\t');
    if (added === '-' || removed === '-') { binaries++; continue; }
    const size = Number(added) + Number(removed);
    if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path.join('\t'))) generated += size;
    else reviewable += size;
  }
  return { reviewable, generated, binaries, overTarget: reviewable + generated > 1000 };
}

export function workflowSummary(record) {
  if (record.usage || !record.schemaVersion) return record;
  const unresolved = (record.observation?.unresolved ?? []).map(thread => ({ id: thread.id, isOutdated: thread.isOutdated, urls: thread.comments?.nodes.map(comment => comment.url) ?? [] }));
  const logs = Object.fromEntries(Object.entries(record.gateLogs ?? {}).map(([name, gate]) => [name, { status: gate.status, exitCode: gate.exitCode, log: gate.log, durationMs: gate.durationMs }]));
  return { status: record.status, branch: record.branch, head: record.head ?? record.publishedHead, pr: record.pr, url: record.url, submission: record.submission, size: record.size, reason: record.reason ?? record.observation?.reason, repairRounds: record.repairRounds.length, failedChecks: record.observation?.failedChecks ?? [], unresolved, logs, localVerifiedHead: record.localVerification?.head };
}

function execute(binary, args, cwd, timeout = 30_000) {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout || `${binary} failed (${result.status})`);
  return result.stdout.trim();
}

const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  number url title state isDraft headRefName headRefOid baseRefName mergeable mergeStateStatus reviewDecision
  reviews(last:100){pageInfo{hasPreviousPage} nodes{author{login __typename} state commit{oid}}}
  reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved isOutdated comments(first:1){nodes{url body}}}}
}}}`;

export async function runWorkflow(args, dependencies = {}) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { usage };
  const [command, ...rest] = args;
  const allowed = { preflight: ['root'], 'prepare-next': ['root', 'branch'], publish: ['root', 'base', 'body-file', 'summary'], status: ['root'], 'record-app-state': ['root', 'receipt'], complete: ['root'], ready: ['root'], repair: ['root', 'reason'], watch: ['root'] };
  if (!Object.hasOwn(allowed, command)) throw new Error(usage);
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index].slice(2), value = rest[index + 1];
    if (!rest[index].startsWith('--') || !allowed[command].includes(name) || Object.hasOwn(values, name) || !value || value.startsWith('--')) throw new Error(usage);
    values[name] = value;
  }
  if (command === 'record-app-state' && !values.receipt) throw new Error('record-app-state requires --receipt with the app list_thread_pull_requests result.');
  if (command === 'publish' && !values['body-file'] || command === 'repair' && !values.reason?.trim()) throw new Error(usage);
  if (command === 'publish' && !validSummary(values.summary)) throw new Error('Provide --summary with 1–80 characters on one line, without surrounding whitespace.');
  if (values.base && values.base !== 'development') throw new Error('The pilot only publishes to development.');
  if (command === 'prepare-next' && !featureName.test(values.branch ?? '')) throw new Error('prepare-next requires --branch feat/NNN-description.');
  const now = dependencies.now ?? (() => Math.floor(performance.now()));
  const deadline = command === 'watch' ? now() + 600_000 : undefined;
  const repo = await repository(values.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
  const call = (binary, argv, timeout = 30_000) => {
    if (deadline !== undefined) {
      timeout = Math.min(timeout, deadline - now());
      if (timeout <= 0) throw new Error('Watch deadline reached.');
    }
    return (dependencies.execute ?? execute)(binary, argv, repo.root, timeout);
  };
  const git = (...argv) => call('git', argv);
  const branch = command === 'preflight' ? git('branch', '--show-current') : git('symbolic-ref', '--quiet', '--short', 'HEAD');
  const origin = git('remote', 'get-url', 'origin');
  const match = origin.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!match) throw new Error('origin must identify a GitHub repository over HTTPS or SSH.');
  if (command === 'preflight') {
    git('fetch', '--no-tags', 'origin', 'refs/heads/development:refs/remotes/origin/development');
    const head = git('rev-parse', 'HEAD'), base = git('rev-parse', 'origin/development');
    const [behind, ahead] = git('rev-list', '--left-right', '--count', `${base}...${head}`).split(/\s+/).map(Number);
    const dirty = git('status', '--porcelain', '--untracked-files=all');
    const branchValid = featureName.test(branch);
    const blockers = [!branchValid && 'Use a feat/NNN-description branch.', behind > 0 && 'Branch is behind development; integrate its changes before editing.', dirty && 'Review existing dirty paths before starting another assignment.'].filter(Boolean);
    const size = changedLines(git('diff', '--numstat', '--no-renames', `${base}...${head}`));
    if (git('rev-parse', 'HEAD') !== head || git('branch', '--show-current') !== branch) throw new Error('Checkout changed during preflight; rerun it.');
    return { status: blockers.length ? 'BLOCKED' : 'READY_TO_WORK', branch, branchValid, head, base, behind, ahead, dirty, size, blockers };
  }
  if (!featureName.test(branch)) throw new Error('Use feat/<three-digit-number>-<lowercase-description>; main and development cannot be published.');
  const remote = match[1], [owner, name] = remote.split('/');
  const gh = (...argv) => call('gh', argv);
  const json = (...argv) => JSON.parse(gh(...argv));
  const store = await dataDirectory(repo, 'pr-workflow');
  const path = resolve(store, `${branch.slice(5)}.json`);
  const processCommand = async () => {
    let record;
    try { record = await readJson(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; record = { schemaVersion: 1, repository: remote, branch, base: 'development', repairRounds: [] }; }
    if (record.schemaVersion !== 1 || record.repository !== remote || record.branch !== branch || record.base !== 'development' || !Array.isArray(record.repairRounds)) throw new Error('Invalid or mismatched PR workflow record.');
    const pairedExecute = (binary, argv, cwd, timeout) => call(binary, argv, timeout);
    const targets = command === 'prepare-next' ? null : await publicationTargets(repo, pairedExecute);
    if (command !== 'prepare-next' && record.pairedTargets && JSON.stringify(record.pairedTargets) !== JSON.stringify(targets)) throw new Error('Paired publication targets changed; restore their configuration and retained accounting.');
    const save = async () => { record.updatedAt = new Date().toISOString(); await atomicWrite(path, JSON.stringify(record, null, 2) + '\n'); };
    const find = () => {
      const prs = json('pr', 'list', '--repo', remote, '--head', branch, '--state', 'open', '--json', 'number,url,baseRefName,headRefOid');
      if (prs.length > 1 || prs.some((pr) => pr.baseRefName !== 'development')) throw new Error('Conflicting open PR/base; inspect before publishing.');
      return prs[0];
    };
    if (command === 'prepare-next') {
      if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('prepare-next requires a clean checkout; commit or preserve local work first.');
      if (!record.pr) throw new Error('A recorded merged PR is required; preserve its workflow accounting.');
      const merged = json('pr', 'view', String(record.pr), '--repo', remote, '--json', 'state,headRefName,baseRefName');
      if (merged.state !== 'MERGED' || merged.headRefName !== branch || merged.baseRefName !== 'development') throw new Error('The recorded PR must be merged into development before preparing another branch.');
      if (values.branch === branch || git('branch', '--list', values.branch)) throw new Error('Choose a different branch; target already exists.');
      git('fetch', '--no-tags', 'origin', 'refs/heads/development:refs/remotes/origin/development');
      const base = git('rev-parse', 'origin/development');
      if (git('status', '--porcelain', '--untracked-files=all') || git('branch', '--show-current') !== branch) throw new Error('Checkout changed during preparation.');
      git('switch', '--no-track', '-c', values.branch, base);
      return { status: 'READY_TO_WORK', branch: values.branch, head: base, base, preservedBranch: branch, mergedPr: record.pr };
    }
    if (command === 'publish') {
      const title = `${branch}: ${values.summary}`;
      const bodyPath = resolve(values['body-file']);
      if ((await stat(bodyPath)).size > 65_536) throw new Error('PR body exceeds 65536 bytes.');
      const body = await readFile(bodyPath, 'utf8');
      if (!body.trim() || Buffer.byteLength(body) > 65_536) throw new Error('PR body must contain 1–65536 bytes.');
      if (targets) {
        const publicContent = `${title}\n${body}`.toLowerCase();
        const privateRepository = targets.submission.repository.toLowerCase();
        if (publicContent.includes(privateRepository) || publicContent.includes(encodeURIComponent(privateRepository))) throw new Error('Public PR content must not include the private repository identity.');
      }
      if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Commit the assigned changes before publishing; checkout must be clean.');
      assertNoTrackedArtifacts(git('ls-files', '-z'));
      const initialPr = find();
      if (record.pr && (!initialPr || initialPr.number !== record.pr)) throw new Error('Recorded PR is closed or replaced; start a new feature branch instead of resetting its budget.');
      if (initialPr && !record.pr && !record.publicationStarted) throw new Error('Existing PR has no local accounting; recover its workflow record before publishing.');
      git('fetch', '--no-tags', 'origin', 'refs/heads/development:refs/remotes/origin/development');
      const size = changedLines(git('diff', '--numstat', '--no-renames', 'origin/development...HEAD'));
      if (!size.reviewable && !size.generated && !size.binaries) throw new Error('No changes against development.');
      const head = git('rev-parse', 'HEAD');
      if (targets) await inspectSubmissionTarget({ repo, targets, branch, execute: pairedExecute });
      const gateLogs = {};
      const gate = async (name, argv) => {
        if (dependencies.execute) return call(process.execPath, argv, 600_000);
        const directory = await dataDirectory(repo, 'pr-workflow-logs');
        try {
          const result = await runGate({ name, args: argv, cwd: repo.root, logPath: resolve(directory, `${Date.now()}-${randomUUID()}-${name}.log`), report: dependencies.report });
          gateLogs[name] = result;
          return result.summary || 'Passed without output.';
        } catch (error) {
          if (error.gate) { record.gateLogs = { ...gateLogs, [name]: error.gate }; await save(); }
          throw error;
        }
      };
      const contextOutput = await gate('context', [resolve(repo.root, 'scripts/ci/check-context.mjs')]);
      const dependencyChanges = git('diff', '--name-only', record.publishedHead ?? 'origin/development', 'HEAD', '--', 'package.json', '**/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs', 'pnpmfile.cjs');
      const installOutput = dependencyChanges ? await gate('dependencies', [resolve(repo.root, 'scripts/ci/check-dependency-install.mjs')]) : 'Dependency inputs unchanged since the last publication/base.';
      const runtimeOutput = await gate('runtime', [resolve(repo.root, 'scripts/ci/check-runtime.mjs')]);
      const testOutput = await gate('tests', ['--test']);
      if (git('status', '--porcelain', '--untracked-files=all') || git('rev-parse', 'HEAD') !== head || git('branch', '--show-current') !== branch) throw new Error('Checkout changed during local gates; inspect before push.');
      let pr = find();
      if (record.pr && (!pr || pr.number !== record.pr)) throw new Error('Recorded PR is closed or replaced; start a new feature branch instead of resetting its budget.');
      if (pr?.number !== initialPr?.number || pr?.headRefOid !== initialPr?.headRefOid) throw new Error('PR changed during local gates; inspect its current head before publishing.');
      record.localVerification = { head, context: contextOutput.slice(-2000), runtime: runtimeOutput.slice(-2000), dependencies: installOutput.slice(-2000), tests: testOutput.split('\n').slice(-10).join('\n') };
      record.gateLogs = gateLogs;
      delete record.completion;
      record.publicationStarted = true;
      if (targets) record.pairedTargets = targets;
      await save();
      git('push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`);
      if (pr) gh('pr', 'edit', String(pr.number), '--repo', remote, '--title', title, '--body-file', bodyPath);
      else {
        gh('pr', 'create', '--repo', remote, '--head', branch, '--base', 'development', '--draft', '--title', title, '--body-file', bodyPath);
        pr = find();
        if (!pr) throw new Error('PR created but lookup failed; rerun publish to recover.');
      }
      Object.assign(record, { pr: pr.number, url: pr.url, head, publishedHead: head, size, status: 'PUBLISHED' });
      await save();
      if (targets) {
        try {
          record.submission = await publishSubmission({ repo, targets, branch, head, title, body, primaryPr: { number: pr.number, url: pr.url }, execute: pairedExecute });
          delete record.submissionError;
          delete record.reason;
          await save();
        } catch (error) {
          record.status = 'PARTIAL_PUBLICATION';
          record.reason = record.submissionError = error.message;
          await save();
          throw new Error(`Public PR published at ${pr.url}; submission publication incomplete. Retain accounting and rerun publish. ${error.message}`);
        }
      }
      if (record.requestedReviewHead !== head) {
        const request = `@coderabbitai review\n\n<!-- slop-loop-review:${head} -->`;
        const pages = json('api', '--paginate', '--slurp', `repos/${remote}/issues/${pr.number}/comments?per_page=100`);
        if (!pages.flat().some((comment) => comment.body === request)) gh('pr', 'comment', String(pr.number), '--repo', remote, '--body', request);
        record.requestedReviewHead = head;
        await save();
      }
      return record;
    }
    if (!record.pr && !record.publicationStarted) throw new Error('Missing PR accounting; restore its original record rather than reset the repair budget.');
    if (command === 'record-app-state') {
      const receipt = await readJson(resolve(values.receipt));
      const linked = (receipt.structuredContent ?? receipt).pullRequests?.find((pr) => pr.url === record.url && pr.repository === remote && pr.number === record.pr);
      if (!linked) throw new Error('The app receipt must include this linked PR.');
      if (targets) {
        const submission = await verifySubmission({ repo, targets, branch, sourceHead: git('rev-parse', 'HEAD'), execute: pairedExecute });
        const pairedLink = (receipt.structuredContent ?? receipt).pullRequests?.find(pr => pr.url === submission.url && pr.repository === submission.repository && pr.number === submission.number);
        if (!pairedLink) throw new Error('The app receipt must include both linked PRs, including submission.');
        record.submission = submission;
        record.submissionAppLink = { url: pairedLink.url, repository: pairedLink.repository, number: pairedLink.number, recordedAt: new Date().toISOString() };
      }
      record.appLink = { url: linked.url, repository: remote, number: linked.number, recordedAt: new Date().toISOString() };
      await save();
      return record;
    }
    const prRef = find();
    if (!prRef) throw new Error('No open feature PR; use publish first.');
    if (record.pr && record.pr !== prRef.number) throw new Error('PR identity changed; inspect the retained record.');
    const pr = json('api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${prRef.number}`).data.repository.pullRequest;
    const head = git('rev-parse', 'HEAD');
    const pages = json('api', '--paginate', '--slurp', `repos/${remote}/commits/${head}/check-runs?per_page=100`);
    const result = assess({ head, pr, checks: pages.flatMap((page) => page.check_runs) });
    Object.assign(record, { pr: pr.number, url: pr.url, head, status: result.status, observation: result });
    delete record.reason;
    if (targets) {
      try {
        record.submission = await verifySubmission({ repo, targets, branch, sourceHead: head, execute: pairedExecute });
        delete record.submissionError;
      } catch (error) {
        record.status = 'PARTIAL_PUBLICATION';
        record.reason = record.submissionError = error.message;
      }
    }
    if (result.status === 'NEEDS_FIX' && record.repairRounds.length >= maxRepairs && record.repairRounds.at(-1)?.head !== head) Object.assign(record, { status: 'BLOCKED', reason: 'Three repair rounds exhausted; human guidance required.' });
    if (command === 'repair') {
      if (record.status !== 'NEEDS_FIX' && !(result.unresolved.length && ['READY_FOR_HUMAN', 'AWAITING_HUMAN_MERGE'].includes(record.status))) throw new Error(`Repair requires a current finding; status is ${record.status}.`);
      if (record.repairRounds.at(-1)?.head === head) throw new Error('A repair is already reserved for this head; publish its fix before reserving another round.');
      if (record.repairRounds.length >= maxRepairs) throw new Error('Three repair rounds exhausted; human guidance required.');
      if (values.reason.length > 2000) throw new Error('Keep the diagnosed repair reason within 2000 characters.');
      record.repairRounds.push({ head, reason: values.reason, startedAt: new Date().toISOString() });
      record.status = 'REPAIR_RESERVED';
    }
    if (command === 'complete') {
      if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Completion requires a clean checkout.');
      if (record.publishedHead !== head || record.localVerification?.head !== head || !['context', 'runtime', 'dependencies', 'tests'].every((gate) => typeof record.localVerification?.[gate] === 'string' && record.localVerification[gate].trim())) throw new Error('Completion requires the current head to be published and locally verified.');
      if (record.appLink?.url !== pr.url || record.appLink?.number !== pr.number || record.appLink?.repository !== remote) throw new Error('Completion requires an app receipt for the linked PR; run record-app-state.');
      if (targets && record.submissionAppLink?.url !== record.submission?.url) throw new Error('Completion requires an app receipt for both linked PRs.');
      if (!['READY_FOR_HUMAN', 'AWAITING_HUMAN_MERGE'].includes(record.status)) throw new Error(`Completion blocked: ${record.status}. Keep the assignment active/blocked and hand pending CI to the app watcher.`);
      if (git('rev-parse', 'HEAD') !== head) throw new Error('Checkout changed during completion verification.');
      record.completion = { head, url: pr.url, pr: pr.number, ci: 'passed', appLink: record.appLink, submission: record.submission, submissionAppLink: record.submissionAppLink, verifiedAt: new Date().toISOString() };
    }
    if (command === 'ready') {
      if (!['READY_FOR_HUMAN', 'AWAITING_HUMAN_MERGE'].includes(record.status)) throw new Error(`Not ready: ${record.status}.`);
      if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Uncommitted work cannot be marked ready.');
      if (targets && record.submission.isDraft) {
        gh('pr', 'ready', String(record.submission.number), '--repo', record.submission.repository);
        record.submission.isDraft = false;
      }
      if (pr.isDraft) gh('pr', 'ready', String(pr.number), '--repo', remote);
      record.status = 'AWAITING_HUMAN_MERGE';
    }
    await save();
    return record;
  };
  if (command !== 'watch') return withLock(`${path}.lock`, processCommand);
  let previous;
  while (now() < deadline) {
    try {
      const record = await withLock(`${path}.lock`, processCommand);
      if (record.status !== previous) { (dependencies.report ?? console.log)(JSON.stringify(workflowSummary(record))); previous = record.status; }
      if (!['WAITING_CI', 'WAITING_REVIEW', 'PUBLISHED'].includes(record.status)) return record;
    } catch (error) { if (now() < deadline) throw error; }
    const delay = Math.max(0, Math.min(15_000, deadline - now()));
    await (dependencies.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))))(delay);
  }
  return { status: 'TIMED_OUT', reason: 'Ten-minute watch ended; state is retained. Resume status/watch later.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorkflow(process.argv.slice(2)).then((result) => console.log(JSON.stringify(workflowSummary(result), null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
