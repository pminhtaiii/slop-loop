import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { featureBranch } from './pr-conventions.mjs';
import { githubRepository } from './publication-targets.mjs';
import { readBoundedEvidence } from './paired-merge-evidence.mjs';

const usage = 'Usage: node scripts/agents/paired-merge-eligibility.mjs [--root <checkout>]';
const required = ['contributor-checks (ubuntu-latest)', 'contributor-checks (windows-latest)', 'runtime-checks (ubuntu-latest)', 'runtime-checks (windows-latest)'];
const hash = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const decode = value => new TextDecoder('utf-8', { fatal: true }).decode(value);
const lower = value => typeof value === 'string' ? value.toLowerCase() : value;
const canonicalTargets = value => Object.fromEntries(['primary', 'submission'].map(side => [side, { ...value?.[side], repository: lower(value?.[side]?.repository) }]));
const explanations = {
  MISSING_EVIDENCE: 'Required configuration or retained publication accounting is missing.',
  READ_FAILED: 'A bounded evidence read could not be completed.',
  INVALID_OR_UNAVAILABLE_EVIDENCE: 'Required evidence could not be validated.',
  CHECKOUT_IDENTITY: 'The checkout identity changed or could not be established.',
  BRANCH_IDENTITY: 'The checkout must use a supported feature branch.',
  DIRTY_CHECKOUT: 'The checkout has uncommitted or untracked changes.',
  TARGET_IDENTITY: 'The configured publication targets do not match this development-only policy.',
  REPOSITORY_VISIBILITY: 'Repository identity or visibility does not match the retained publication roles.',
  PUBLIC_ACCOUNTING: 'Public publication accounting does not match the current candidate.',
  PAIR_ACCOUNTING: 'Retained public and submission accounting is incomplete or inconsistent.',
  PR_IDENTITY: 'A live PR does not match its exact retained repository, branch or revision.',
  PR_NOT_READY: 'Both PRs must be open, non-draft and cleanly mergeable.',
  MERGEABILITY_PENDING: 'GitHub has not finished determining whether the PR can be merged.',
  PR_METADATA: 'Live PR metadata differs from the retained publication.',
  PAIR_MARKER: 'The submission PR is missing its retained publication marker.',
  TREE_IDENTITY: 'Live PR source trees do not match the retained public source tree.',
  CHECK_PAGINATION: 'Complete and consistent public check-run pages could not be established.',
  MISSING_CHECKS: 'A required public check is missing for the exact candidate revision.',
  FAILED_CHECK: 'A required public check failed for the exact candidate revision.',
  PENDING_CHECKS: 'Required public checks have not all completed successfully.',
  MISSING_OBJECTS: 'The exact public base and head objects must already exist locally.',
  INCOMPLETE_HISTORY: 'Complete local public history is required to establish base ancestry.',
  STALE_BASE: 'The public head does not include the currently observed development base.',
  SUBMISSION_BASE: 'The submission head does not include its currently observed development base.',
  LOCAL_TREE_IDENTITY: 'The local immutable source tree differs from live publication evidence.',
  EVIDENCE_CHANGED: 'Bound evidence changed during inspection; run a fresh preview.',
  CHANGE_COUNT: 'The change must contain between one and one hundred documentation paths.',
  PATH_POLICY: 'A changed path is outside the narrow documentation allowlist.',
  GOVERNANCE_PATH: 'Governance and agent instructions require human review.',
  FILE_OPERATION: 'Only additions and modifications of ordinary non-executable files are eligible.',
  CONTENT_LIMIT: 'Documentation content exceeds the per-file or combined inspection limit.',
  TEXT_ENCODING: 'Documentation must contain valid UTF-8 text.',
  TEXT_CONTENT: 'Binary or control-character content requires human review.',
  PROSE_CONTENT: 'Code examples or raw HTML require human review under this prose-only policy.',
  MALFORMED_DIFF: 'The complete immutable change set could not be validated.',
  BLOB_SIZE: 'Immutable file content does not match its observed size.',
  OUTPUT_LIMIT: 'An evidence read exceeded the bounded output limit.',
  LINKED_EVIDENCE: 'Publication evidence must use regular unlinked files and directories.',
  INVALID_EVIDENCE: 'Publication evidence has an unsupported type or exceeds its size bound.',
};
class Refusal extends Error {
  constructor(code, status = 'BLOCKED') { super(code); this.status = status; }
}
function requireEvidence(condition, code, status) { if (!condition) throw new Refusal(code, status); }
function execute(binary, args, cwd, timeout, options) {
  const result = spawnSync(binary, args, { ...options, cwd, timeout, windowsHide: true, shell: false });
  if (result.error || result.status !== 0) throw new Refusal('READ_FAILED', 'WAITING_EVIDENCE');
  return result.stdout;
}
async function regular(root, components) {
  let path = root, expected;
  for (let i = 0; i < components.length; i++) {
    path = resolve(path, components[i]);
    let info;
    try { info = await lstat(path, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') throw new Refusal('MISSING_EVIDENCE', 'WAITING_EVIDENCE'); throw error; }
    requireEvidence(!info.isSymbolicLink() && await realpath(path) === path, 'LINKED_EVIDENCE');
    requireEvidence(i === components.length - 1 ? info.isFile() && info.size <= 2n * 1024n * 1024n : info.isDirectory(), 'INVALID_EVIDENCE');
    if (i === components.length - 1) expected = info;
  }
  let bytes;
  try { bytes = await readBoundedEvidence(path, expected, 2 * 1024 * 1024); }
  catch (error) { if (error.code === 'ENOENT') throw new Refusal('MISSING_EVIDENCE', 'WAITING_EVIDENCE'); throw error; }
  requireEvidence(Buffer.isBuffer(bytes), 'INVALID_EVIDENCE');
  return bytes;
}

function checkObservation(pages, head) {
  requireEvidence(Array.isArray(pages) && pages.length > 0 && pages.every(page => page && Number.isSafeInteger(page.total_count) && page.total_count >= 0 && Array.isArray(page.check_runs)), 'CHECK_PAGINATION');
  const count = pages[0].total_count, runs = pages.flatMap(page => page.check_runs);
  requireEvidence(pages.every(page => page.total_count === count) && runs.length === count && runs.every(run => run && Number.isSafeInteger(run.id) && run.id > 0) && new Set(runs.map(run => run.id)).size === runs.length, 'CHECK_PAGINATION');
  const checks = required.map(name => runs.filter(run => run?.name === name && run.head_sha === head && run.app?.slug === 'github-actions').sort((a, b) => b.id - a.id)[0]);
  requireEvidence(checks.every(check => check && Number.isSafeInteger(check.id) && check.id > 0), 'MISSING_CHECKS', 'WAITING_EVIDENCE');
  requireEvidence(!checks.some(check => check.status === 'completed' && check.conclusion !== 'success'), 'FAILED_CHECK');
  requireEvidence(checks.every(check => check.status === 'completed' && check.conclusion === 'success'), 'PENDING_CHECKS', 'WAITING_EVIDENCE');
  return checks.map(({ id, name, head_sha, status, conclusion, app }) => ({ id, name, head: head_sha, status, conclusion, app: app.slug }));
}

function classify(call, git, base, head, tree) {
  try { git('cat-file', '-e', `${base}^{commit}`); git('cat-file', '-e', `${head}^{commit}`); }
  catch { throw new Refusal('MISSING_OBJECTS', 'WAITING_EVIDENCE'); }
  const shallow = git('rev-parse', '--is-shallow-repository');
  requireEvidence(['true', 'false'].includes(shallow), 'INVALID_EVIDENCE');
  requireEvidence(shallow === 'false', 'INCOMPLETE_HISTORY', 'WAITING_EVIDENCE');
  const excluded = git('rev-list', '--max-count=1', base, '--not', head);
  requireEvidence(excluded === '' || hash(excluded), 'INVALID_EVIDENCE');
  requireEvidence(excluded === '', 'STALE_BASE');
  requireEvidence(git('rev-parse', `${head}^{tree}`) === tree, 'LOCAL_TREE_IDENTITY');
  const raw = decode(call('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-abbrev', '--raw', '-z', base, head]));
  const fields = raw.split('\0');
  requireEvidence(fields.pop() === '' && fields.length % 2 === 0, 'MALFORMED_DIFF');
  requireEvidence(fields.length >= 2 && fields.length <= 200, 'CHANGE_COUNT', 'MANUAL_REVIEW');
  let total = 0;
  for (let i = 0; i < fields.length; i += 2) {
    const match = fields[i].match(/^:(\d{6}) (\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([A-Z][0-9]*)$/);
    requireEvidence(match, 'MALFORMED_DIFF');
    const [, oldMode, newMode, oldBlob, newBlob, status] = match;
    const path = fields[i + 1], parts = path.split('/');
    requireEvidence((path === 'README.md' || /^docs\/(?:user|guides)\/.+\.md$/.test(path)) && parts.every(part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part)), 'PATH_POLICY', 'MANUAL_REVIEW');
    requireEvidence(!parts.some(part => /^(?:agents|adr|context|specs|policy|policies|contracts|AGENTS\.md|CLAUDE\.md|SKILL\.md|GLOSSARY\.md|CONTRIBUTING\.md|SECURITY\.md|CODEOWNERS)$/i.test(part)), 'GOVERNANCE_PATH', 'MANUAL_REVIEW');
    requireEvidence(newMode === '100644' && (status === 'A' && oldMode === '000000' && /^0+$/.test(oldBlob) || status === 'M' && oldMode === '100644'), 'FILE_OPERATION', 'MANUAL_REVIEW');
    for (const blob of status === 'A' ? [newBlob] : [oldBlob, newBlob]) {
      const sizeText = git('cat-file', '-s', blob), size = Number(sizeText);
      requireEvidence(/^\d+$/.test(sizeText), 'BLOB_SIZE');
      requireEvidence(Number.isSafeInteger(size) && size >= 0 && size <= 65536 && (total += size) <= 1048576, 'CONTENT_LIMIT', 'MANUAL_REVIEW');
      const bytes = call('git', ['cat-file', 'blob', blob]);
      requireEvidence(bytes.length === size, 'BLOB_SIZE');
      let content;
      try { content = decode(bytes); } catch { throw new Refusal('TEXT_ENCODING', 'MANUAL_REVIEW'); }
      requireEvidence(!Array.from(content).some(char => { const code = char.charCodeAt(0); return code >= 127 && code <= 159 || code < 32 && ![9, 10, 13].includes(code); }), 'TEXT_CONTENT', 'MANUAL_REVIEW');
      requireEvidence(!/```|~~~|<|^(?: {4}|\t)/m.test(content), 'PROSE_CONTENT', 'MANUAL_REVIEW');
    }
  }
}

export async function runEligibility(args, dependencies = {}) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { usage };
  if (args.length && (args.length !== 2 || args[0] !== '--root' || !args[1] || args[1].startsWith('--'))) throw new Error(usage);
  const report = (status, code, snapshot) => ({ schemaVersion: 1, policy: 'docs-v1', status, eligible: status === 'ELIGIBLE_PREVIEW', mergeEnabled: false, reasons: code ? [{ code, explanation: explanations[code] ?? 'Required evidence could not be validated.' }] : [], ...(snapshot && { snapshot }) });
  let snapshot;
  try {
    const root = await realpath(args[1] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
    const call = (binary, argv) => {
      const options = { shell: false, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1' } };
      let value;
      try { value = (dependencies.execute ?? execute)(binary, binary === 'git' ? ['-c', 'core.fsmonitor=false', ...argv] : argv, root, 60_000, options); }
      catch (error) { if (error instanceof Refusal) throw error; throw new Refusal('READ_FAILED', 'WAITING_EVIDENCE'); }
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
      requireEvidence(buffer.length <= options.maxBuffer, 'OUTPUT_LIMIT');
      return buffer;
    };
    const git = (...argv) => decode(call('git', argv)).trim();
    const json = endpoint => JSON.parse(decode(call('gh', ['api', '--method', 'GET', endpoint])));
    requireEvidence(await realpath(git('rev-parse', '--show-toplevel')) === root, 'CHECKOUT_IDENTITY');
    const inventory = decode(call('git', ['worktree', 'list', '--porcelain', '-z']));
    requireEvidence(inventory.startsWith('worktree '), 'CHECKOUT_IDENTITY');
    const primary = await realpath(inventory.split('\0')[0].slice(9));
    const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
    requireEvidence(featureBranch.test(branch), 'BRANCH_IDENTITY');
    const observe = async () => {
      const head = git('rev-parse', 'HEAD');
      requireEvidence(hash(head) && git('symbolic-ref', '--quiet', '--short', 'HEAD') === branch, 'CHECKOUT_IDENTITY');
      requireEvidence(git('status', '--porcelain', '--untracked-files=all') === '', 'DIRTY_CHECKOUT');
      const configBytes = await regular(root, ['publication-targets.json']);
      const workflowBytes = await regular(primary, ['.agent-work', 'pr-workflow', `${branch.slice(5)}.json`]);
      const pairBytes = await regular(primary, ['.agent-work', 'paired-prs', `${branch.replaceAll('/', '-')}.json`]);
      const config = JSON.parse(decode(configBytes)), workflow = JSON.parse(decode(workflowBytes)), pair = JSON.parse(decode(pairBytes));
      requireEvidence(config.schemaVersion === 1 && config.submission?.remote === 'submission' && config.submission.base === 'development', 'TARGET_IDENTITY');
      const targets = {}, remoteUrls = {}, visibility = {};
      for (const [side, remote] of [['primary', 'origin'], ['submission', 'submission']]) {
        const effectiveUrl = git('remote', 'get-url', remote);
        const repository = githubRepository(effectiveUrl).toLowerCase();
        targets[side] = { remote, repository, base: 'development' };
        remoteUrls[side] = effectiveUrl;
        const info = json(`repos/${repository}`);
        requireEvidence(info.full_name?.toLowerCase() === repository && info.private === (side === 'submission') && info.visibility === (side === 'submission' ? 'private' : 'public'), 'REPOSITORY_VISIBILITY');
        visibility[side] = info.visibility;
      }
      requireEvidence(targets.primary.repository !== targets.submission.repository, 'TARGET_IDENTITY');
      requireEvidence(workflow.schemaVersion === 1 && lower(workflow.repository) === targets.primary.repository && workflow.branch === branch && workflow.base === 'development' && workflow.publishedHead === head && Number.isSafeInteger(workflow.pr) && workflow.pr > 0 && isDeepStrictEqual(canonicalTargets(workflow.pairedTargets), targets), 'PUBLIC_ACCOUNTING');
      requireEvidence(pair.schemaVersion === 1 && pair.branch === branch && pair.base === 'development' && lower(pair.repository) === targets.submission.repository && isDeepStrictEqual(canonicalTargets(pair.targets), targets) && pair.phase === 'complete' && pair.sourceHead === head && hash(pair.sourceTree) && hash(pair.mirrorHead) && hash(pair.mainBase) && Number.isSafeInteger(pair.prNumber) && pair.prNumber > 0 && typeof pair.marker === 'string' && /^<!-- paired-submission:[A-Za-z0-9-]+ -->$/.test(pair.marker), 'PAIR_ACCOUNTING');
      const cached = { repository: targets.submission.repository, number: pair.prNumber, url: `https://github.com/${targets.submission.repository}/pull/${pair.prNumber}`, branch, base: 'development', head: pair.mirrorHead, sourceHead: head, sourceTree: pair.sourceTree };
      requireEvidence(Object.entries(cached).every(([key, value]) => (['repository', 'url'].includes(key) ? lower(workflow.submission?.[key]) : workflow.submission?.[key]) === value), 'PAIR_ACCOUNTING');
      const prs = {}, trees = {};
      for (const side of ['primary', 'submission']) {
        const repository = targets[side].repository, number = side === 'primary' ? workflow.pr : pair.prNumber;
        const expectedHead = side === 'primary' ? head : pair.mirrorHead;
        const url = `https://github.com/${repository}/pull/${number}`;
        const pr = json(`repos/${repository}/pulls/${number}`);
        requireEvidence(pr.number === number && pr.html_url?.toLowerCase() === url && (side === 'primary' ? workflow.url : pair.prUrl)?.toLowerCase() === url && pr.head?.ref === branch && pr.head.sha === expectedHead && pr.head.repo?.full_name?.toLowerCase() === repository && pr.base?.ref === 'development' && hash(pr.base.sha) && pr.base.repo?.full_name?.toLowerCase() === repository, 'PR_IDENTITY');
        const mergeStates = ['clean', 'unknown', 'dirty', 'behind', 'blocked', 'draft', 'unstable', 'has_hooks'];
        requireEvidence(pr.state === 'open' && pr.draft === false && [true, false, null].includes(pr.mergeable) && mergeStates.includes(pr.mergeable_state), 'PR_NOT_READY');
        requireEvidence(pr.mergeable !== false && ['clean', 'unknown'].includes(pr.mergeable_state), 'PR_NOT_READY');
        requireEvidence(pr.mergeable !== null && pr.mergeable_state !== 'unknown', 'MERGEABILITY_PENDING', 'WAITING_EVIDENCE');
        requireEvidence(pr.title === pair.title && typeof pr.title === 'string' && pr.title.startsWith(`${branch}: `), 'PR_METADATA');
        if (side === 'submission') requireEvidence(typeof pr.body === 'string' && pr.body.includes(pair.marker), 'PAIR_MARKER');
        const commit = json(`repos/${repository}/git/commits/${expectedHead}`);
        requireEvidence(commit.sha === expectedHead && hash(commit.tree?.sha) && commit.tree.sha === pair.sourceTree, 'TREE_IDENTITY');
        prs[side] = { number, head: expectedHead, base: pr.base.sha, state: pr.state, draft: pr.draft, mergeable: pr.mergeable, mergeState: pr.mergeable_state, title: pr.title, marker: side === 'submission' ? pair.marker : undefined };
        trees[side] = commit.tree.sha;
      }
      const comparison = json(`repos/${targets.submission.repository}/compare/${prs.submission.base}...${prs.submission.head}`);
      requireEvidence(comparison.base_commit?.sha === prs.submission.base && comparison.merge_base_commit?.sha === prs.submission.base && ['ahead', 'identical'].includes(comparison.status) && comparison.behind_by === 0 && Number.isSafeInteger(comparison.ahead_by) && (comparison.status === 'ahead' ? comparison.ahead_by > 0 && prs.submission.head !== prs.submission.base : comparison.ahead_by === 0 && prs.submission.head === prs.submission.base), 'SUBMISSION_BASE');
      const ancestry = { base: comparison.base_commit.sha, mergeBase: comparison.merge_base_commit.sha, status: comparison.status, ahead: comparison.ahead_by, behind: comparison.behind_by };
      const pages = JSON.parse(decode(call('gh', ['api', '--paginate', '--slurp', '--method', 'GET', `repos/${targets.primary.repository}/commits/${head}/check-runs?per_page=100`])));
      const checks = checkObservation(pages, head);
      return { head, targets, remoteUrls, visibility, configBytes, workflowBytes, pairBytes, prs, trees, ancestry, checks };
    };
    const initial = await observe();
    snapshot = { observedOnly: true, publicHead: initial.head, submissionHead: initial.prs.submission.head, publicBase: initial.prs.primary.base, submissionBase: initial.prs.submission.base, tree: initial.trees.primary, checks: initial.checks, publicUrl: `https://github.com/${initial.targets.primary.repository}/pull/${initial.prs.primary.number}`, submissionNumber: initial.prs.submission.number };
    classify(call, git, initial.prs.primary.base, initial.head, initial.trees.primary);
    const final = await observe();
    requireEvidence(isDeepStrictEqual(initial, final), 'EVIDENCE_CHANGED');
    return report('ELIGIBLE_PREVIEW', undefined, snapshot);
  } catch (error) {
    return report(error instanceof Refusal ? error.status : 'BLOCKED', error instanceof Refusal ? error.message : 'INVALID_OR_UNAVAILABLE_EVIDENCE', snapshot);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runEligibility(process.argv.slice(2)), null, 2)); }
  catch { console.error(usage); process.exitCode = 1; }
}
