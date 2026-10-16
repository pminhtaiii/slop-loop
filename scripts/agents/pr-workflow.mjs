import { spawnSync } from 'node:child_process';
import { assertNoTrackedDependencies } from '../ci/check-tracked-files.mjs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, dataDirectory, readJson, repository, withLock } from './agent-store.mjs';

const checksRequired = ['contributor-checks (ubuntu-latest)', 'contributor-checks (windows-latest)'];
const featureName = /^feat\/\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const maxRepairs = 3;
const usage = `Usage: node scripts/agents/pr-workflow.mjs <preflight|publish|status|ready|repair|watch> [--root <checkout>]
preflight fetches origin/development and reports freshness, naming, dirty paths, and diff size; it never publishes.
publish requires --body-file <file> and --summary <short summary>; optional --base development.
repair requires --reason <diagnosed finding>. At most three repair rounds per PR.
watch polls for at most ten minutes, stopping for fixes, human approval, or timeout.
The helper never commits, merges, force-pushes, or resolves review threads.`;

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
  else if (result.unresolved.length) result.status = 'NEEDS_FIX';
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
  const allowed = { preflight: ['root'], publish: ['root', 'base', 'body-file', 'summary'], status: ['root'], ready: ['root'], repair: ['root', 'reason'], watch: ['root'] };
  if (!Object.hasOwn(allowed, command)) throw new Error(usage);
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index].slice(2), value = rest[index + 1];
    if (!rest[index].startsWith('--') || !allowed[command].includes(name) || Object.hasOwn(values, name) || !value || value.startsWith('--')) throw new Error(usage);
    values[name] = value;
  }
  if (command === 'publish' && !values['body-file'] || command === 'repair' && !values.reason?.trim()) throw new Error(usage);
  if (command === 'publish' && !validSummary(values.summary)) throw new Error('Provide --summary with 1–80 characters on one line, without surrounding whitespace.');
  if (values.base && values.base !== 'development') throw new Error('The pilot only publishes to development.');
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
    const save = async () => { record.updatedAt = new Date().toISOString(); await atomicWrite(path, JSON.stringify(record, null, 2) + '\n'); };
    const find = () => {
      const prs = json('pr', 'list', '--repo', remote, '--head', branch, '--state', 'open', '--json', 'number,url,baseRefName');
      if (prs.length > 1 || prs.some((pr) => pr.baseRefName !== 'development')) throw new Error('Conflicting open PR/base; inspect before publishing.');
      return prs[0];
    };
    if (command === 'publish') {
      const title = `${branch}: ${values.summary}`;
      const bodyPath = resolve(values['body-file']);
      if ((await stat(bodyPath)).size > 65_536) throw new Error('PR body exceeds 65536 bytes.');
      const body = await readFile(bodyPath, 'utf8');
      if (!body.trim() || Buffer.byteLength(body) > 65_536) throw new Error('PR body must contain 1–65536 bytes.');
      if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Commit the assigned changes before publishing; checkout must be clean.');
      assertNoTrackedDependencies(git('ls-files', '-z'));
      git('fetch', '--no-tags', 'origin', 'refs/heads/development:refs/remotes/origin/development');
      const size = changedLines(git('diff', '--numstat', '--no-renames', 'origin/development...HEAD'));
      if (!size.reviewable && !size.generated && !size.binaries) throw new Error('No changes against development.');
      const head = git('rev-parse', 'HEAD');
      const contextOutput = call(process.execPath, [resolve(repo.root, 'scripts/ci/check-context.mjs')], 600_000);
      const testOutput = call(process.execPath, ['--test'], 600_000);
      if (git('status', '--porcelain', '--untracked-files=all') || git('rev-parse', 'HEAD') !== head) throw new Error('Checkout changed during local gates; inspect before push.');
      let pr = find();
      if (record.pr && (!pr || pr.number !== record.pr)) throw new Error('Recorded PR is closed or replaced; start a new feature branch instead of resetting its budget.');
      if (pr && !record.pr && !record.publicationStarted) throw new Error('Existing PR has no local accounting; recover its workflow record before publishing.');
      record.localVerification = { head, context: contextOutput.slice(-2000), tests: testOutput.split('\n').slice(-10).join('\n') };
      record.publicationStarted = true;
      await save();
      git('push', 'origin', `HEAD:refs/heads/${branch}`);
      if (pr) gh('pr', 'edit', String(pr.number), '--repo', remote, '--title', title, '--body-file', bodyPath);
      else {
        gh('pr', 'create', '--repo', remote, '--head', branch, '--base', 'development', '--draft', '--title', title, '--body-file', bodyPath);
        pr = find();
        if (!pr) throw new Error('PR created but lookup failed; rerun publish to recover.');
      }
      Object.assign(record, { pr: pr.number, url: pr.url, publishedHead: head, size, status: 'PUBLISHED' });
      await save();
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
    const prRef = find();
    if (!prRef) throw new Error('No open feature PR; use publish first.');
    if (record.pr && record.pr !== prRef.number) throw new Error('PR identity changed; inspect the retained record.');
    const pr = json('api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${prRef.number}`).data.repository.pullRequest;
    const head = git('rev-parse', 'HEAD');
    const pages = json('api', '--paginate', '--slurp', `repos/${remote}/commits/${head}/check-runs?per_page=100`);
    const result = assess({ head, pr, checks: pages.flatMap((page) => page.check_runs) });
    Object.assign(record, { pr: pr.number, url: pr.url, head, status: result.status, observation: result });
    delete record.reason;
    if (result.status === 'NEEDS_FIX' && record.repairRounds.length >= maxRepairs && record.repairRounds.at(-1)?.head !== head) Object.assign(record, { status: 'BLOCKED', reason: 'Three repair rounds exhausted; human guidance required.' });
    if (command === 'repair') {
      if (record.status !== 'NEEDS_FIX') throw new Error(`Repair requires a current finding; status is ${record.status}.`);
      if (record.repairRounds.at(-1)?.head === head) throw new Error('A repair is already reserved for this head; publish its fix before reserving another round.');
      if (values.reason.length > 2000) throw new Error('Keep the diagnosed repair reason within 2000 characters.');
      record.repairRounds.push({ head, reason: values.reason, startedAt: new Date().toISOString() });
      record.status = 'REPAIR_RESERVED';
    }
    if (command === 'ready') {
      if (!['READY_FOR_HUMAN', 'AWAITING_HUMAN_MERGE'].includes(record.status)) throw new Error(`Not ready: ${record.status}.`);
      if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Uncommitted work cannot be marked ready.');
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
      if (record.status !== previous) { (dependencies.report ?? console.log)(JSON.stringify(record)); previous = record.status; }
      if (!['WAITING_CI', 'WAITING_REVIEW', 'PUBLISHED'].includes(record.status)) return record;
    } catch (error) { if (now() < deadline) throw error; }
    const delay = Math.max(0, Math.min(15_000, deadline - now()));
    await (dependencies.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))))(delay);
  }
  return { status: 'TIMED_OUT', reason: 'Ten-minute watch ended; state is retained. Resume status/watch later.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorkflow(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
