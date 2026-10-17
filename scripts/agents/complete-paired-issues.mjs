import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, dataDirectory, readJson, repository, withLock } from './agent-store.mjs';
import { publicationTargets, withPublicationBody } from './publication-targets.mjs';

const sides = ['primary', 'submission'];
const featureBranch = /^feat\/\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const usage = 'Usage: node scripts/agents/complete-paired-issues.mjs --key <stable-key> --pr <public-PR-URL> --evidence-file <JSON> [--apply] [--root <checkout>]';
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function execute(binary, args, cwd, timeout = 30_000) {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout || `${binary} failed (${result.status})`);
  return result.stdout.trim();
}

function parseArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const values = { apply: false };
  const valued = new Set(['key', 'pr', 'evidence-file', 'root']);
  for (let index = 0; index < args.length;) {
    const option = args[index++];
    if (option === '--apply') {
      if (values.apply) throw new Error(usage);
      values.apply = true;
      continue;
    }
    const name = option?.slice(2);
    const value = args[index++];
    if (!option?.startsWith('--') || !valued.has(name) || Object.hasOwn(values, name) || !value || value.startsWith('--')) throw new Error(usage);
    values[name] = value;
  }
  if (!values.key || !values.pr || !values['evidence-file']) throw new Error(usage);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.key) || values.key.length > 80) throw new Error('Provide --key as a lowercase stable slug of at most 80 characters.');
  return values;
}

async function readEvidence(path) {
  const bytes = await readFile(resolve(path));
  if (bytes.length > 65_536) throw new Error('Evidence file exceeds 65536 bytes.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Evidence file must contain valid UTF-8.'); }
  if (text.includes('\0')) throw new Error('Evidence file must not contain NUL characters.');
  let input;
  try { input = JSON.parse(text); }
  catch { throw new Error('Evidence file must contain valid JSON.'); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== 1 || typeof input.summary !== 'string' || !input.summary.trim() || !Array.isArray(input.acceptance) || !input.acceptance.length) {
    throw new Error('Evidence must use schemaVersion 1 with a nonblank summary and at least one acceptance entry.');
  }
  const acceptance = input.acceptance.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.criterion !== 'string' || !entry.criterion.trim() || typeof entry.evidence !== 'string' || !entry.evidence.trim()) {
      throw new Error('Each acceptance entry needs nonblank criterion and evidence text.');
    }
    return { criterion: entry.criterion.trim(), evidence: entry.evidence.trim() };
  });
  const evidence = { schemaVersion: 1, summary: input.summary.trim(), acceptance };
  if ([evidence.summary, ...acceptance.flatMap((item) => [item.criterion, item.evidence])].some((value) => value.includes('\0'))) throw new Error('Evidence text must not contain NUL characters.');
  return { evidence, source: text, decoded: JSON.stringify(input), sha256: createHash('sha256').update(JSON.stringify(evidence)).digest('hex') };
}

function command(call, args, repo, timeout = 30_000) {
  const result = call('gh', args, repo.root, timeout);
  return typeof result === 'string' ? result.trim() : String(result?.stdout ?? '').trim();
}

function json(call, args, repo, description) {
  try { return JSON.parse(command(call, args, repo)); }
  catch (error) { throw new Error(`Could not read ${description}: ${error.message}`); }
}

function pages(output, description) {
  let parsed;
  try { parsed = JSON.parse(output); }
  catch { throw new Error(`GitHub returned invalid ${description} JSON.`); }
  if (!Array.isArray(parsed) || parsed.some((page) => !Array.isArray(page))) throw new Error(`Could not confirm complete ${description} pagination.`);
  return parsed.flat();
}

function issueMarker(repositoryName, key) {
  const digest = createHash('sha256').update(repositoryName.toLowerCase() + '\0' + key).digest('hex');
  return `<!-- paired-issue:sha256:${digest} -->`;
}

function hasLine(text, marker) {
  return typeof text === 'string' && text.split(/\r\n|\n|\r/).includes(marker);
}

function privateIdentityAppears(text, repositoryName) {
  const normalized = String(text).toLowerCase();
  return normalized.includes(repositoryName.toLowerCase()) || normalized.includes(encodeURIComponent(repositoryName).toLowerCase());
}

function validateTarget(side, target, metadata) {
  const expectedVisibility = side === 'primary' ? 'PUBLIC' : 'PRIVATE';
  if (!metadata || typeof metadata !== 'object' || metadata.nameWithOwner?.toLowerCase() !== target.repository.toLowerCase()) throw new Error(`GitHub repository identity does not match the configured ${side} target.`);
  if (metadata.visibility !== expectedVisibility) throw new Error(`The ${side} repository must be ${expectedVisibility.toLowerCase()}.`);
  if (!['WRITE', 'MAINTAIN', 'ADMIN'].includes(metadata.viewerPermission)) throw new Error(`Write permission is required for the ${side} repository.`);
  if (metadata.hasIssuesEnabled !== true) throw new Error(`Issues must be enabled for the ${side} repository.`);
}

function issueUrl(repositoryName, issue) {
  if (!Number.isSafeInteger(issue?.number) || issue.number < 1 || typeof issue.html_url !== 'string') throw new Error('A marker-matched issue has an invalid identity.');
  let parsed;
  try { parsed = new URL(issue.html_url); }
  catch { throw new Error('A marker-matched issue has an invalid URL.'); }
  const expectedPath = `/${repositoryName}/issues/${issue.number}`;
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.pathname.toLowerCase() !== expectedPath.toLowerCase() || parsed.search || parsed.hash || !['open', 'closed'].includes(String(issue.state).toLowerCase())) {
    throw new Error('A marker-matched issue belongs to a different identity or has an invalid state.');
  }
  const body = typeof issue.body === 'string' ? issue.body.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : '';
  return {
    number: issue.number,
    url: `https://github.com/${repositoryName}/issues/${issue.number}`,
    state: String(issue.state).toLowerCase(),
    bodySha256: createHash('sha256').update(body).digest('hex'),
  };
}

function listIssues(call, repo, target) {
  const endpoint = `repos/${target.repository}/issues?state=all&per_page=100`;
  return pages(command(call, ['api', '--paginate', '--slurp', '--method', 'GET', endpoint], repo, 60_000), `${target.repository} issue`);
}

function findIssue(call, repo, target, marker) {
  const matches = listIssues(call, repo, target).filter((issue) => hasLine(issue.body, marker));
  if (matches.some((issue) => issue.pull_request)) throw new Error(`The stable marker belongs to a pull request in the ${target.remote} repository.`);
  if (matches.length > 1) throw new Error(`Multiple issues contain the stable marker in the ${target.remote} repository.`);
  return matches[0] ? issueUrl(target.repository, matches[0]) : null;
}

function validateIssueRecord(record, key, marker, targets, found) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.schemaVersion !== 1 || record.key !== key || record.marker !== marker) throw new Error('Paired issue record has a mismatched stable-key identity.');
  if (!record.targets || sides.some((side) => typeof record.targets[side] !== 'string' || record.targets[side].toLowerCase() !== targets[side].repository.toLowerCase())) throw new Error('Paired issue targets changed; restore their configuration or reconcile the retained record.');
  if (!record.receipts || sides.some((side) => !Object.hasOwn(record.receipts, side))) throw new Error('Paired issue record has invalid receipts.');
  for (const side of sides) {
    const receipt = record.receipts[side];
    if (!receipt) continue;
    if (!found[side] || receipt.number !== found[side].number || typeof receipt.url !== 'string' || receipt.url.toLowerCase() !== found[side].url.toLowerCase()) throw new Error(`The saved ${side} issue receipt no longer matches its stable marker.`);
  }
}

async function resolveIssuePair(call, repo, values, targets) {
  const marker = issueMarker(targets.primary.repository, values.key);
  const directory = await dataDirectory(repo, 'paired-issues');
  const recordPath = resolve(directory, `${values.key}.json`);
  let existing;
  try { existing = await readJson(recordPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const found = Object.fromEntries(sides.map((side) => [side, findIssue(call, repo, targets[side], marker)]));
  if (existing) validateIssueRecord(existing, values.key, marker, targets, found);
  if (sides.some((side) => !found[side])) throw new Error('Could not find both issues by their stable marker; markerless issues are never adopted.');
  return { marker, issues: found };
}

function parsePullUrl(url, repositoryName) {
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error('Provide the public resolving PR URL for the configured origin repository.'); }
  const match = parsed.pathname.match(/^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/i);
  const number = Number(match?.[2]);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || !match || !Number.isSafeInteger(number) || match[1].toLowerCase() !== repositoryName.toLowerCase()) {
    throw new Error('The public resolving PR URL must match the configured origin repository.');
  }
  return { number, url: `https://github.com/${repositoryName}/pull/${number}` };
}

function validHash(value) { return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value); }

function validPrUrl(value, repositoryName, number) {
  return typeof value === 'string' && value.toLowerCase() === `https://github.com/${repositoryName}/pull/${number}`.toLowerCase();
}

function readPr(call, repo, repositoryName, number, side, branch, expectedBase) {
  const fields = 'number,url,state,mergedAt,headRefName,headRefOid,baseRefName,isDraft,isCrossRepository';
  const pr = json(call, ['pr', 'view', String(number), '--repo', repositoryName, '--json', fields], repo, `${side} PR`);
  if (pr.number !== number || !validPrUrl(pr.url, repositoryName, number) || pr.isCrossRepository !== false) throw new Error(`The ${side} PR identity is invalid, cross-repository, or changed.`);
  if (pr.headRefName !== branch || pr.baseRefName !== expectedBase || !featureBranch.test(pr.headRefName ?? '') || !validHash(pr.headRefOid)) {
    throw new Error(`The ${side} PR must use the expected feature branch and base.`);
  }
  if (!['OPEN', 'CLOSED', 'MERGED'].includes(pr.state)) throw new Error(`GitHub returned an invalid ${side} PR state.`);
  if (pr.state === 'MERGED' && (typeof pr.mergedAt !== 'string' || !pr.mergedAt.trim())) throw new Error(`The merged ${side} PR has no mergedAt timestamp.`);
  return pr;
}

function readSubmissionPr(call, repo, target, branch) {
  const listed = json(call, ['pr', 'list', '--repo', target.repository, '--head', branch, '--state', 'all', '--limit', '1000', '--json', 'number,url,baseRefName,headRefName,state'], repo, 'submission PR list');
  if (!Array.isArray(listed)) throw new Error('GitHub returned an invalid submission PR list.');
  if (listed.length > 1) throw new Error('Multiple submission PRs use this feature branch; inspect before completing issues.');
  if (!listed.length) return null;
  const item = listed[0];
  if (!Number.isSafeInteger(item?.number) || item.number < 1 || item.headRefName !== branch || item.baseRefName !== target.base) throw new Error('The submission PR does not use the public feature branch and configured base (historical main requires its original configuration).');
  return readPr(call, repo, target.repository, item.number, 'submission', branch, target.base);
}

function prIdentity(pr, repositoryName) {
  return { repository: repositoryName, number: pr.number, url: pr.url, branch: pr.headRefName, base: pr.baseRefName };
}

function completionMarker(publicRepository, key) {
  const digest = createHash('sha256').update(publicRepository.toLowerCase() + '\0' + key).digest('hex');
  return `<!-- paired-issue-completion:sha256:${digest} -->`;
}

function validateCompletionRecord(record, expected) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.schemaVersion !== 1 || record.key !== expected.key || record.issueMarker !== expected.issueMarker || record.completionMarker !== expected.completionMarker) throw new Error('Paired issue completion record has a mismatched stable-key identity.');
  if (JSON.stringify(record.targets) !== JSON.stringify(expected.targets) || JSON.stringify(record.issues) !== JSON.stringify(expected.issues) || JSON.stringify(record.resolvingPr) !== JSON.stringify(expected.resolvingPr)) throw new Error('Paired issue targets, issue identities, or resolving PR changed; inspect the retained completion record.');
  if (!record.progress || sides.some((side) => !record.progress[side] || typeof record.progress[side] !== 'object')) throw new Error('Paired issue completion record has invalid per-side progress.');
  const effectsStarted = record.applyStarted === true || sides.some((side) => ['commentIntent', 'commented', 'closeIntent', 'closed'].some((field) => record.progress[side][field] === true));
  if (record.evidenceSha256 !== expected.evidenceSha256 && effectsStarted) throw new Error('Completion evidence changed after apply intent or an audit effect began.');
  if (record.evidenceSha256 !== expected.evidenceSha256) delete record.verified;
  record.evidenceSha256 = expected.evidenceSha256;
}

async function loadCompletionRecord(path, expected) {
  try {
    const record = await readJson(path);
    validateCompletionRecord(record, expected);
    return record;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { ...expected, progress: { primary: {}, submission: {} } };
  }
}

async function saveCompletionRecord(path, record) {
  record.updatedAt = new Date().toISOString();
  await atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
}

const requiredChecks = [
  'contributor-checks (ubuntu-latest)',
  'contributor-checks (windows-latest)',
  'runtime-checks (ubuntu-latest)',
  'runtime-checks (windows-latest)',
];

function readCheckRuns(call, repo, repositoryName, head) {
  const endpoint = `repos/${repositoryName}/commits/${head}/check-runs?per_page=100`;
  const output = command(call, ['api', '--paginate', '--slurp', '--method', 'GET', endpoint], repo, 60_000);
  let responses;
  try { responses = JSON.parse(output); }
  catch { throw new Error('GitHub returned invalid check-run JSON.'); }
  if (!Array.isArray(responses) || !responses.length || responses.some((page) => !page || typeof page !== 'object' || !Array.isArray(page.check_runs))) throw new Error('Could not confirm complete public check-run pagination.');
  return responses.flatMap((page) => page.check_runs);
}

function assessChecks(call, repo, repositoryName, head) {
  const checks = readCheckRuns(call, repo, repositoryName, head);
  const latest = requiredChecks.map((name) => checks
    .filter((check) => check?.name === name && check.head_sha?.toLowerCase() === head.toLowerCase() && check.app?.slug === 'github-actions')
    .sort((left, right) => Number(right.id) - Number(left.id))[0]);
  const signatures = latest.map((check) => check ? {
    name: check.name,
    head: check.head_sha,
    status: check.status,
    conclusion: check.conclusion,
    app: check.app.slug,
  } : null);
  if (latest.some((check) => !check || !Number.isSafeInteger(check.id) || check.id < 1)) return { status: 'WAITING_CI', checks: signatures };
  if (latest.some((check) => check.status === 'completed' && check.conclusion !== 'success')) return { status: 'BLOCKED', checks: signatures, reason: 'A required exact-head GitHub Actions check failed.' };
  if (latest.some((check) => check.status !== 'completed' || check.conclusion !== 'success')) return { status: 'WAITING_CI', checks: signatures };
  return { status: 'READY', checks: signatures };
}

function readCommitTree(call, repo, repositoryName, head) {
  const commit = json(call, ['api', `repos/${repositoryName}/git/commits/${head}`], repo, `${repositoryName} commit tree`);
  if (commit?.sha?.toLowerCase() !== head.toLowerCase() || !validHash(commit?.tree?.sha)) throw new Error(`GitHub returned an invalid commit tree for ${repositoryName}.`);
  return commit.tree.sha.toLowerCase();
}

function mergedSnapshot(call, repo, targets, publicPr, submissionPr) {
  const checks = assessChecks(call, repo, targets.primary.repository, publicPr.headRefOid);
  if (checks.status !== 'READY') return { ...checks };
  const publicTree = readCommitTree(call, repo, targets.primary.repository, publicPr.headRefOid);
  const submissionTree = readCommitTree(call, repo, targets.submission.repository, submissionPr.headRefOid);
  if (publicTree !== submissionTree) return { status: 'BLOCKED', reason: 'The public and submission PR heads have different Git trees.' };
  return {
    status: 'READY',
    verified: {
      publicHead: publicPr.headRefOid.toLowerCase(),
      submissionHead: submissionPr.headRefOid.toLowerCase(),
      publicTree,
      submissionTree,
      publicMergedAt: publicPr.mergedAt,
      submissionMergedAt: submissionPr.mergedAt,
      checks: checks.checks,
    },
  };
}

function commentBody(pr, evidence, marker) {
  return [
    `Completed with [PR #${pr.number}](${pr.url}).`,
    '',
    `Acceptance criteria attested: ${evidence.acceptance.length}.`,
    `Evidence SHA-256: ${createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}`,
    'Detailed evidence is retained locally by the completing agent.',
    '',
    marker,
  ].join('\n');
}

function readIssueComments(call, repo, target, issue) {
  const endpoint = `repos/${target.repository}/issues/${issue.number}/comments?per_page=100`;
  return pages(command(call, ['api', '--paginate', '--slurp', '--method', 'GET', endpoint], repo, 60_000), `${target.repository} issue comment`);
}

function existingCompletionComment(comments, marker, body, side) {
  const completionComments = comments.filter((comment) => typeof comment?.body === 'string' && /<!-- paired-issue-completion:[^>]+ -->/.test(comment.body));
  const matching = completionComments.filter((comment) => hasLine(comment.body, marker));
  if (matching.length > 1 || completionComments.length > matching.length) throw new Error(`Conflicting completion markers exist on the ${side} issue.`);
  if (!matching.length) return false;
  const normalize = (value) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalize(matching[0].body) !== normalize(body)) throw new Error(`A completion marker on the ${side} issue has conflicting evidence.`);
  return true;
}

function sameVerifiedSnapshot(previous, current) {
  return JSON.stringify(previous) === JSON.stringify(current);
}

async function postComment(repo, call, target, issue, body) {
  const args = ['issue', 'comment', String(issue.number), '--repo', target.repository, '--body-file'];
  return withPublicationBody(repo, body, (path) => command(call, [...args, path], repo));
}

function expectedRecord(values, pair, targets, publicPr, submissionPr, evidenceInput) {
  return {
    schemaVersion: 1,
    key: values.key,
    issueMarker: pair.marker,
    completionMarker: completionMarker(targets.primary.repository, values.key),
    targets: { primary: targets.primary.repository, submission: targets.submission.repository },
    issues: Object.fromEntries(sides.map((side) => [side, { number: pair.issues[side].number, url: pair.issues[side].url }])),
    resolvingPr: {
      primary: prIdentity(publicPr, targets.primary.repository),
      submission: prIdentity(submissionPr, targets.submission.repository),
    },
    evidenceSha256: evidenceInput.sha256,
  };
}

async function inspectCurrent(values, evidenceInput, repo, call, targets, recordPath) {
  if ([evidenceInput.source, evidenceInput.decoded, JSON.stringify(evidenceInput.evidence)].some((text) => privateIdentityAppears(text, targets.submission.repository))) {
    throw new Error('Evidence must not include the private repository identity.');
  }
  for (const side of sides) {
    const metadata = json(call, ['repo', 'view', targets[side].repository, '--json', 'nameWithOwner,visibility,viewerPermission,hasIssuesEnabled'], repo, `${side} repository`);
    validateTarget(side, targets[side], metadata);
  }
  const pair = await resolveIssuePair(call, repo, values, targets);
  const publicUrl = parsePullUrl(values.pr, targets.primary.repository);
  const fields = 'number,url,state,mergedAt,headRefName,headRefOid,baseRefName,isDraft,isCrossRepository';
  const publicPr = json(call, ['pr', 'view', String(publicUrl.number), '--repo', targets.primary.repository, '--json', fields], repo, 'public PR');
  if (publicPr.number !== publicUrl.number || !validPrUrl(publicPr.url, targets.primary.repository, publicUrl.number) || publicPr.isCrossRepository !== false) throw new Error('The public PR identity is invalid, cross-repository, or changed.');
  if (!featureBranch.test(publicPr.headRefName ?? '') || publicPr.baseRefName !== 'development' || !validHash(publicPr.headRefOid)) throw new Error('The public PR must use a feat/NNN-description branch and development base.');
  if (!['OPEN', 'CLOSED', 'MERGED'].includes(publicPr.state)) throw new Error('GitHub returned an invalid public PR state.');
  if (publicPr.state === 'MERGED' && (typeof publicPr.mergedAt !== 'string' || !publicPr.mergedAt.trim())) throw new Error('The merged public PR has no mergedAt timestamp.');
  const submissionPr = readSubmissionPr(call, repo, targets.submission, publicPr.headRefName);
  if (!submissionPr) {
    try {
      await readJson(recordPath);
      throw new Error('The retained submission PR is missing or was replaced.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return { status: 'WAITING_SUBMISSION_PR', pair, publicUrl, publicPr, submissionPr: null };
  }
  const expected = expectedRecord(values, pair, targets, publicPr, submissionPr, evidenceInput);
  if (publicPr.state === 'CLOSED' || submissionPr.state === 'CLOSED') return { status: 'BLOCKED', reason: 'A resolving PR closed without merging.', pair, publicUrl, publicPr, submissionPr, expected };
  if (publicPr.state !== 'MERGED' || submissionPr.state !== 'MERGED') return { status: 'WAITING_PR', pair, publicUrl, publicPr, submissionPr, expected };
  const merged = mergedSnapshot(call, repo, targets, publicPr, submissionPr);
  if (merged.verified) merged.verified.issueBodies = Object.fromEntries(sides.map((side) => [side, pair.issues[side].bodySha256]));
  return { ...merged, pair, publicUrl, publicPr, submissionPr, expected };
}

function issueCommentsState(call, repo, targets, current, evidence, record) {
  const bodies = {
    primary: commentBody(current.publicPr, evidence, record.completionMarker),
    submission: commentBody(current.submissionPr, evidence, record.completionMarker),
  };
  for (const side of sides) {
    if (Buffer.byteLength(bodies[side], 'utf8') > 65_536) throw new Error(`The ${side} completion comment exceeds 65536 bytes.`);
    if (side === 'primary' && privateIdentityAppears(bodies[side], targets.submission.repository)) throw new Error('Public completion comments must not include the private repository identity.');
  }
  const comments = {};
  for (const side of sides) {
    const listed = readIssueComments(call, repo, targets[side], current.pair.issues[side]);
    comments[side] = existingCompletionComment(listed, record.completionMarker, bodies[side], side);
    if (record.progress[side].commented === true && !comments[side]) throw new Error(`The recorded ${side} completion comment is missing.`);
    if (comments[side]) {
      record.progress[side].commented = true;
      record.progress[side].commentIntent = false;
    }
    if (current.pair.issues[side].state === 'closed') {
      record.progress[side].closed = true;
      record.progress[side].closeIntent = false;
    }
  }
  return { bodies, comments };
}

function snapshotMatches(record, verified) {
  if (record.verified && !sameVerifiedSnapshot(record.verified, verified)) throw new Error('The merged PR heads, merge state, source trees, or exact-head CI evidence changed after preview.');
}

async function saveWaitingRecord(recordPath, expected) {
  const record = await loadCompletionRecord(recordPath, expected);
  await saveCompletionRecord(recordPath, record);
  return record;
}

export async function runIssueCompletion(args, dependencies = {}) {
  const values = parseArgs(args);
  if (values.help) return { usage };
  const evidenceInput = await readEvidence(values['evidence-file']);
  const repo = await repository(values.root ?? defaultRoot);
  const call = (binary, argv, cwd, timeout) => (dependencies.execute ?? execute)(binary, argv, cwd, timeout);
  const targets = await publicationTargets(repo, call);
  if (!targets) throw new Error('Paired issue completion requires publication-targets.json.');
  const keyDirectory = await dataDirectory(repo, 'paired-issue-completion');
  const recordPath = resolve(keyDirectory, `${values.key}.json`);
  const lockPath = resolve(keyDirectory, `${values.key}.lock`);

  return withLock(lockPath, async () => {
    let current = await inspectCurrent(values, evidenceInput, repo, call, targets, recordPath);
    if (!current.expected) return { status: current.status, key: values.key, public: current.publicUrl.url };
    let record = await loadCompletionRecord(recordPath, current.expected);

    if (current.status !== 'READY') {
      await saveCompletionRecord(recordPath, record);
      return { status: current.status, key: values.key, reason: current.reason };
    }

    snapshotMatches(record, current.verified);
    let { bodies, comments } = issueCommentsState(call, repo, targets, current, evidenceInput.evidence, record);
    for (const side of sides) {
      if (comments[side]) record.progress[side].commented = true;
      if (current.pair.issues[side].state === 'closed') record.progress[side].closed = true;
    }

    if (!values.apply) {
      record.verified = current.verified;
      await saveCompletionRecord(recordPath, record);
      const closed = sides.every((side) => current.pair.issues[side].state === 'closed');
      return { status: closed ? 'COMPLETED' : 'READY_TO_COMPLETE', key: values.key, public: current.publicPr.url, submission: current.submissionPr.url };
    }

    if (sides.every((side) => current.pair.issues[side].state === 'closed')) {
      record.verified = current.verified;
      for (const side of sides) record.progress[side].closed = true;
      await saveCompletionRecord(recordPath, record);
      return { status: 'COMPLETED', key: values.key, public: current.publicPr.url, submission: current.submissionPr.url };
    }

    // Recheck the whole admission snapshot after local body preparation and before the first issue write.
    const beforeComments = await inspectCurrent(values, evidenceInput, repo, call, targets, recordPath);
    if (beforeComments.status !== 'READY') throw new Error('PR, CI, tree, or issue evidence changed before completion comments could be added.');
    validateCompletionRecord(record, beforeComments.expected);
    if (!sameVerifiedSnapshot(current.verified, beforeComments.verified)) throw new Error('PR, CI, tree, or issue evidence changed before completion comments could be added.');
    current = beforeComments;
    ({ bodies, comments } = issueCommentsState(call, repo, targets, current, evidenceInput.evidence, record));

    record.applyStarted = true;
    record.verified = current.verified;
    await saveCompletionRecord(recordPath, record);
    for (const side of sides) {
      const beforeComment = await inspectCurrent(values, evidenceInput, repo, call, targets, recordPath);
      if (beforeComment.status !== 'READY' || !sameVerifiedSnapshot(record.verified, beforeComment.verified)) throw new Error('PR, CI, tree, or issue evidence changed before completion comments could be added.');
      validateCompletionRecord(record, beforeComment.expected);
      current = beforeComment;
      ({ bodies, comments } = issueCommentsState(call, repo, targets, current, evidenceInput.evidence, record));
      if (current.pair.issues[side].state === 'closed') {
        record.progress[side].closed = true;
        await saveCompletionRecord(recordPath, record);
        continue;
      }
      if (comments[side]) {
        record.progress[side].commented = true;
        await saveCompletionRecord(recordPath, record);
        continue;
      }
      record.progress[side].commentIntent = true;
      record.progress[side].commentBodySha256 = createHash('sha256').update(bodies[side]).digest('hex');
      await saveCompletionRecord(recordPath, record);
      await postComment(repo, call, targets[side], current.pair.issues[side], bodies[side]);
      record.progress[side].commentIntent = false;
      record.progress[side].commented = true;
      await saveCompletionRecord(recordPath, record);
    }

    for (const side of sides) {
      // Recheck both repositories before each close; a close may itself race with edits on the other issue.
      const beforeClose = await inspectCurrent(values, evidenceInput, repo, call, targets, recordPath);
      if (beforeClose.status !== 'READY') throw new Error('PR, CI, tree, or issue evidence changed before issue closure.');
      validateCompletionRecord(record, beforeClose.expected);
      snapshotMatches(record, beforeClose.verified);
      const closeComments = issueCommentsState(call, repo, targets, beforeClose, evidenceInput.evidence, record);
      if (beforeClose.pair.issues[side].state === 'closed') {
        record.progress[side].closed = true;
        await saveCompletionRecord(recordPath, record);
        continue;
      }
      if (!closeComments.comments[side]) throw new Error(`The ${side} audit comment is missing before issue closure.`);
      record.progress[side].closeIntent = true;
      await saveCompletionRecord(recordPath, record);
      command(call, ['issue', 'close', String(beforeClose.pair.issues[side].number), '--repo', targets[side].repository, '--reason', 'completed'], repo);
      record.progress[side].closeIntent = false;
      record.progress[side].closed = true;
      await saveCompletionRecord(recordPath, record);
    }

    const finalPair = await resolveIssuePair(call, repo, values, targets);
    if (sides.some((side) => finalPair.issues[side].number !== current.pair.issues[side].number || finalPair.issues[side].url !== current.pair.issues[side].url || finalPair.issues[side].bodySha256 !== current.pair.issues[side].bodySha256 || finalPair.issues[side].state !== 'closed')) {
      throw new Error('GitHub did not close both exact paired issues; rerun completion to recover.');
    }
    for (const side of sides) record.progress[side].closed = true;
    await saveCompletionRecord(recordPath, record);
    return { status: 'COMPLETED', key: values.key, public: current.publicPr.url, submission: current.submissionPr.url };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runIssueCompletion(process.argv.slice(2)).then((result) => {
    console.log(result.usage ?? JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
