import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEligibility } from '../../scripts/agents/paired-merge-eligibility.mjs';

const source = new URL('../../scripts/agents/paired-merge-eligibility.mjs', import.meta.url);
const branch = 'feat/tooling-preview';
const required = ['contributor-checks (ubuntu-latest)', 'contributor-checks (windows-latest)', 'runtime-checks (ubuntu-latest)', 'runtime-checks (windows-latest)'];

async function fixture(t, { path = 'docs/user/overview.md', content = 'Readable prose.\n', before, operation } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paired-preview-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet'); git('config', 'user.name', 'Preview Tests'); git('config', 'user.email', 'preview@example.invalid');
  git('config', 'core.symlinks', 'false');
  git('checkout', '--quiet', '-b', branch);
  git('remote', 'add', 'origin', 'https://github.com/example/public.git');
  git('remote', 'add', 'submission', 'https://github.com/secret/coursework.git');
  await writeFile(join(root, '.gitignore'), '.agent-work/\n');
  await writeFile(join(root, 'publication-targets.json'), JSON.stringify({ schemaVersion: 1, submission: { remote: 'submission', base: 'development' } }));
  await mkdir(dirname(join(root, path)), { recursive: true });
  if (before !== undefined) await writeFile(join(root, path), before);
  git('add', '.'); git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  if (operation === 'delete') await rm(join(root, path));
  else if (operation === 'rename') git('mv', path, 'docs/user/renamed.md');
  else await writeFile(join(root, path), content);
  git('add', '.'); git('commit', '--quiet', '-m', 'prose');
  if (operation === 'executable' || operation === 'symlink') {
    const blob = git('rev-parse', `HEAD:${path}`);
    git('update-index', '--cacheinfo', `${operation === 'symlink' ? '120000' : '100755'},${blob},${path}`);
    git('commit', '--quiet', '-m', 'mode change');
    git('reset', '--hard', '--quiet', 'HEAD');
  }
  const head = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  const mirror = git('commit-tree', tree, '-p', base, '-m', 'submission snapshot');
  const targets = { primary: { remote: 'origin', repository: 'example/public', base: 'development' }, submission: { remote: 'submission', repository: 'secret/coursework', base: 'development' } };
  const marker = '<!-- paired-submission:fixture -->';
  const title = `${branch}: document the overview`;
  const workflow = { schemaVersion: 1, repository: 'example/public', branch, base: 'development', publishedHead: head, pr: 1, url: 'https://github.com/example/public/pull/1', pairedTargets: targets, repairRounds: [], submission: { repository: 'secret/coursework', number: 2, url: 'https://github.com/secret/coursework/pull/2', branch, base: 'development', head: mirror, sourceHead: head, sourceTree: tree, isDraft: false } };
  const pair = { schemaVersion: 1, targets, repository: 'secret/coursework', branch, base: 'development', mainBase: base, sourceHead: head, sourceTree: tree, mirrorHead: mirror, previousMirrorHead: null, phase: 'complete', marker, title, body: `Public review PR: ${workflow.url}\n${marker}`, prNumber: 2, prUrl: 'https://github.com/secret/coursework/pull/2' };
  const record = join(root, '.agent-work/paired-prs/feat-tooling-preview.json');
  await mkdir(dirname(record), { recursive: true });
  await mkdir(join(root, '.agent-work/pr-workflow'));
  await writeFile(record, JSON.stringify(pair));
  await writeFile(join(root, '.agent-work/pr-workflow/tooling-preview.json'), JSON.stringify(workflow));
  const pr = (repository, number, sha) => ({ number, html_url: `https://github.com/${repository}/pull/${number}`, state: 'open', draft: false, title, body: pair.body, mergeable: true, mergeable_state: 'clean', head: { ref: branch, sha, repo: { full_name: repository } }, base: { ref: 'development', sha: base, repo: { full_name: repository } } });
  const state = { primary: pr('example/public', 1, head), submission: pr('secret/coursework', 2, mirror), pages: [{ total_count: 4, check_runs: required.map((name, i) => ({ id: i + 1, name, head_sha: head, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } })) }] };
  let ghReads = 0, observations = 0, mutationAttempts = 0;
  const execute = (binary, args, cwd, timeout, options) => {
    if (binary === 'git') {
      assert.equal(options.env.GIT_NO_LAZY_FETCH, '1'); assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
      assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, '1');
      assert.deepEqual(args.slice(0, 2), ['-c', 'core.fsmonitor=false']);
      const readable = ['rev-parse', 'symbolic-ref', 'status', 'merge-base', 'diff', 'cat-file'].includes(args[2]) || args[2] === 'worktree' && args[3] === 'list' || args[2] === 'remote' && args[3] === 'get-url';
      if (!readable) mutationAttempts++;
      assert.ok(readable, 'Git mutations are forbidden');
      const result = spawnSync(binary, args, { ...options, cwd, timeout, windowsHide: true });
      if (result.status !== 0) throw new Error('simulated Git command failure');
      return result.stdout;
    }
    if (binary !== 'gh' || args[0] !== 'api' || args[args.indexOf('--method') + 1] !== 'GET') mutationAttempts++;
    assert.equal(binary, 'gh'); assert.equal(args[0], 'api');
    assert.equal(options.env.GH_PROMPT_DISABLED, '1'); assert.equal(options.env.GH_NO_UPDATE_NOTIFIER, '1'); assert.equal(options.env.GH_NO_EXTENSION_UPDATE_NOTIFIER, '1');
    assert.equal(args[args.indexOf('--method') + 1], 'GET', 'GitHub mutations are forbidden');
    ghReads++;
    state.onRead?.(ghReads);
    const endpoint = args.at(-1);
    if (endpoint === 'repos/example/public' && ++observations === 2) state.beforeFinal?.();
    if (state.unavailable?.(endpoint)) throw new Error('https://github.com/secret/coursework read unavailable');
    if (state.malformed?.(endpoint)) return '{not valid JSON';
    if (endpoint.endsWith('/check-runs?per_page=100')) { state.afterChecks?.(); return JSON.stringify(state.pages); }
    if (endpoint.endsWith('/pulls/1')) return JSON.stringify(state.primary);
    if (endpoint.endsWith('/pulls/2')) return JSON.stringify(state.submission);
    if (endpoint.includes('/git/commits/')) return JSON.stringify({ sha: endpoint.split('/').at(-1), tree: { sha: state.tree ?? tree } });
    if (endpoint.includes('/compare/')) return JSON.stringify(state.comparison ?? { base_commit: { sha: state.submission.base.sha }, merge_base_commit: { sha: state.submission.base.sha }, status: 'ahead', ahead_by: 1, behind_by: 0 });
    return JSON.stringify({ full_name: endpoint.endsWith('example/public') ? 'example/public' : 'secret/coursework', private: !endpoint.endsWith('example/public'), visibility: state.visibility ?? (endpoint.endsWith('example/public') ? 'public' : 'private') });
  };
  const run = async () => { observations = 0; const report = await runEligibility(['--root', root], { execute }); assert.equal(mutationAttempts, 0, 'Preview attempted a mutation'); return report; };
  return { root, git, head, base, mirror, tree, state, pair, record, execute, run };
}

async function files(root) {
  const result = {};
  async function visit(path, prefix) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      result[name] = entry.isDirectory() ? 'directory' : (await readFile(join(path, entry.name))).toString('base64');
      if (entry.isDirectory()) await visit(join(path, entry.name), `${name}/`);
    }
  }
  await visit(root, '');
  return result;
}

test('CLI reports missing publication evidence as JSON without creating record directories', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paired-preview-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const args of [['init', '--quiet'], ['checkout', '--quiet', '-b', 'feat/tooling-preview'], ['-c', 'user.name=Tests', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'base']]) {
    const git = spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
  }
  const before = await files(root);
  const result = spawnSync(process.execPath, [fileURLToPath(source), '--root', root], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.eligible, false);
  assert.equal(report.status, 'WAITING_EVIDENCE');
  assert.equal(report.mergeEnabled, false);
  assert.equal(typeof report.reasons[0].explanation, 'string');
  assert.ok(report.reasons[0].explanation.length > 10 && report.reasons[0].explanation.length + report.reasons[0].code.length <= 200);
  assert.deepEqual(await files(root), before);
});

test('a synchronized prose-only pair produces a revision-bound preview without writes', async t => {
  const f = await fixture(t);
  const before = await files(f.root);
  const report = await f.run();
  assert.equal(report.status, 'ELIGIBLE_PREVIEW');
  assert.equal(report.eligible, true);
  assert.equal(report.mergeEnabled, false);
  assert.equal(report.snapshot.publicHead, f.head);
  assert.equal(report.snapshot.submissionHead, f.mirror);
  assert.equal(report.snapshot.publicBase, f.base);
  assert.equal(report.snapshot.submissionBase, f.base);
  assert.doesNotMatch(JSON.stringify(report), /secret|coursework/);
  assert.deepEqual(await files(f.root), before);
});

test('tooling, governance and executable examples require manual review', async t => {
  for (const options of [{ path: 'scripts/change.mjs' }, { path: 'docs/user/policies/limits.md' }, { content: '```js\nrun()\n```\n' }, { content: '<script>run()</script>' }, { before: '    executable example\n', content: 'Prose now.\n' }]) {
    const f = await fixture(t, options);
    const report = await f.run();
    assert.equal(report.status, 'MANUAL_REVIEW', JSON.stringify(report));
    assert.equal(report.eligible, false);
  }
});

test('required checks are selected across complete pages and newer failures supersede success', async t => {
  const f = await fixture(t);
  const checks = f.state.pages[0].check_runs;
  f.state.pages = [{ total_count: 4, check_runs: checks.slice(0, 3) }, { total_count: 4, check_runs: checks.slice(3) }];
  assert.equal((await f.run()).eligible, true);
  f.state.pages = [{ total_count: 5, check_runs: checks }, { total_count: 5, check_runs: [{ ...checks[0], id: 9, conclusion: 'failure' }] }];
  assert.equal((await f.run()).reasons[0].code, 'FAILED_CHECK');
  f.state.pages = [{ total_count: 5, check_runs: checks }];
  assert.equal((await f.run()).reasons[0].code, 'CHECK_PAGINATION');
  f.state.pages = [null];
  assert.equal((await f.run()).eligible, false);
});

test('missing, stale, spoofed or pending public checks never establish eligibility', async t => {
  const f = await fixture(t), checks = structuredClone(f.state.pages[0].check_runs);
  for (const change of [runs => { runs[0].head_sha = f.base; }, runs => { runs[0].app.slug = 'other'; }, runs => { runs[0].status = 'in_progress'; }, runs => { runs.splice(0, 1); }]) {
    const runs = structuredClone(checks); change(runs);
    f.state.pages = [{ total_count: runs.length, check_runs: runs }];
    const report = await f.run();
    assert.equal(report.status, 'WAITING_EVIDENCE');
    assert.equal(report.eligible, false);
  }
});

test('both PRs must preserve their exact identities, states and source tree', async t => {
  const f = await fixture(t);
  for (const side of ['primary', 'submission']) {
    const original = structuredClone(f.state[side]);
    for (const delta of [{ draft: true }, { state: 'closed' }, { mergeable: null }, { mergeable_state: 'behind' }, { number: 99 }, { head: { ...original.head, sha: f.base } }, { head: { ...original.head, repo: { full_name: 'attacker/fork' } } }]) {
      f.state[side] = { ...original, ...delta };
      assert.equal((await f.run()).status, 'BLOCKED');
    }
    f.state[side] = original;
  }
  f.state.tree = f.base;
  assert.equal((await f.run()).reasons[0].code, 'TREE_IDENTITY');
});

test('final base and check rerun changes invalidate an otherwise eligible observation', async t => {
  for (const mutate of [f => { f.state.submission.base.sha = 'a'.repeat(40); }, f => { const runs = f.state.pages[0].check_runs; runs.push({ ...runs[0], id: 99 }); f.state.pages[0].total_count++; }]) {
    const f = await fixture(t);
    f.state.beforeFinal = () => mutate(f);
    const report = await f.run();
    assert.equal(report.status, 'BLOCKED');
    assert.equal(report.reasons[0].code, 'EVIDENCE_CHANGED');
  }
});

test('binary and invalid or oversized text require manual review', async t => {
  for (const content of [Buffer.from([0xff]), Buffer.from('text\0binary'), 'a'.repeat(65537), '\tindented\n', '~~~\ncode\n~~~']) {
    const f = await fixture(t, { content });
    assert.equal((await f.run()).status, 'MANUAL_REVIEW');
  }
});

test('file deletion, rename, executable modes and symlinks require manual review', async t => {
  for (const operation of ['delete', 'rename', 'executable', 'symlink']) {
    const f = await fixture(t, { before: 'Old prose.\n', operation });
    assert.equal((await f.run()).status, 'MANUAL_REVIEW');
  }
});

test('configured filesystem monitor is never executed and absent records stay absent', async t => {
  const f = await fixture(t);
  const hook = join(f.root, '.agent-work/monitor.cjs'), marker = join(f.root, '.agent-work/monitor-ran');
  await writeFile(hook, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  f.git('config', 'core.fsmonitor', `"${process.execPath}" "${hook}"`);
  const before = await files(f.root);
  assert.equal((await f.run()).eligible, true);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.deepEqual(await files(f.root), before);
  await rm(dirname(f.record), { recursive: true });
  const missingBefore = await files(f.root);
  assert.equal((await f.run()).status, 'WAITING_EVIDENCE');
  assert.deepEqual(await files(f.root), missingBefore);
});

test('missing local base objects, invalid records and private visibility changes fail closed', async t => {
  const f = await fixture(t);
  f.state.primary.base.sha = 'f'.repeat(40);
  assert.equal((await f.run()).reasons[0].code, 'MISSING_OBJECTS');
  f.state.primary.base.sha = f.base;
  const original = await readFile(f.record, 'utf8');
  await writeFile(f.record, JSON.stringify({ ...f.pair, sourceHead: f.base }));
  assert.equal((await f.run()).reasons[0].code, 'PAIR_ACCOUNTING');
  await writeFile(f.record, original);
  f.state.onRead = () => { f.state.visibility = 'public'; };
  assert.equal((await f.run()).eligible, false);
});

test('cached workflow submission identity must agree with retained pair identity', async t => {
  const f = await fixture(t);
  const path = join(f.root, '.agent-work/pr-workflow/tooling-preview.json');
  const record = JSON.parse(await readFile(path, 'utf8'));
  record.submission.number = 99;
  await writeFile(path, JSON.stringify(record));
  assert.equal((await f.run()).reasons[0].code, 'PAIR_ACCOUNTING');
});

test('unknown invocation is rejected before commands and raw command errors remain private', async t => {
  for (const args of [['--apply'], ['merge'], ['--root', 'x', '--root', 'y']]) await assert.rejects(runEligibility(args, { execute() { assert.fail('No command expected'); } }), /Usage/);
  const f = await fixture(t);
  const report = await runEligibility(['--root', f.root], { execute() { throw new Error('https://github.com/secret/coursework private failure'); } });
  assert.equal(report.status, 'WAITING_EVIDENCE');
  assert.doesNotMatch(JSON.stringify(report), /secret|coursework|private failure/);
});

test('C1 controls require manual review and preserve the observed public-safe snapshot', async t => {
  const f = await fixture(t, { content: 'Text\u0085control\n' });
  const before = await files(f.root), report = await f.run();
  assert.equal(report.status, 'MANUAL_REVIEW');
  assert.equal(report.reasons[0].code, 'TEXT_CONTENT');
  assert.equal(report.snapshot.publicHead, f.head);
  assert.equal(report.snapshot.submissionHead, f.mirror);
  assert.equal(report.snapshot.observedOnly, true);
  assert.doesNotMatch(JSON.stringify(report), /secret|coursework/);
  assert.deepEqual(await files(f.root), before);
});

test('every cached workflow submission identity and provenance field must match', async t => {
  const f = await fixture(t), path = join(f.root, '.agent-work/pr-workflow/tooling-preview.json');
  const original = JSON.parse(await readFile(path, 'utf8'));
  for (const key of ['repository', 'number', 'url', 'branch', 'base', 'head', 'sourceHead', 'sourceTree']) {
    const changed = structuredClone(original);
    changed.submission[key] = key === 'number' ? 99 : 'wrong';
    await writeFile(path, JSON.stringify(changed));
    assert.equal((await f.run()).reasons[0].code, 'PAIR_ACCOUNTING', key);
  }
});

test('unavailable reads wait while malformed remote data blocks', async t => {
  const f = await fixture(t);
  f.state.unavailable = endpoint => endpoint.endsWith('/pulls/2');
  assert.equal((await f.run()).status, 'WAITING_EVIDENCE');
  f.state.unavailable = undefined;
  f.state.malformed = endpoint => endpoint.endsWith('/pulls/2');
  assert.equal((await f.run()).status, 'BLOCKED');
});

test('a clean submission PR still requires exact live base ancestry', async t => {
  const f = await fixture(t);
  f.state.comparison = { base_commit: { sha: f.base }, merge_base_commit: { sha: f.head }, status: 'diverged', ahead_by: 1, behind_by: 1 };
  assert.equal((await f.run()).reasons[0].code, 'SUBMISSION_BASE');
  f.state.comparison = { base_commit: { sha: f.base }, merge_base_commit: { sha: f.base }, status: 'ahead', ahead_by: 1, behind_by: 0 };
  assert.equal((await f.run()).eligible, true);
  for (const delta of [{ ahead_by: '1' }, { behind_by: -1 }, { base_commit: { sha: f.head } }, { status: 'identical', ahead_by: 0 }]) {
    const valid = structuredClone(f.state.comparison);
    f.state.comparison = { ...valid, ...delta };
    assert.equal((await f.run()).status, 'BLOCKED');
    f.state.comparison = valid;
  }
  f.state.beforeFinal = () => { f.state.comparison.ahead_by = 2; };
  assert.equal((await f.run()).reasons[0].code, 'EVIDENCE_CHANGED');
  f.state.beforeFinal = () => { f.state.unavailable = endpoint => endpoint.includes('/compare/'); };
  const unavailable = await f.run();
  assert.equal(unavailable.status, 'WAITING_EVIDENCE');
  assert.equal(unavailable.snapshot.observedOnly, true);
});

test('mixed-case retained repositories and canonical URLs retain eligibility', async t => {
  const f = await fixture(t), path = join(f.root, '.agent-work/pr-workflow/tooling-preview.json');
  const workflow = JSON.parse(await readFile(path, 'utf8'));
  for (const record of [workflow, f.pair]) {
    const targets = record.pairedTargets ?? record.targets;
    targets.primary.repository = 'Example/Public'; targets.submission.repository = 'Secret/Coursework';
  }
  workflow.repository = 'Example/Public'; workflow.url = 'https://github.com/Example/Public/pull/1';
  workflow.submission.repository = 'Secret/Coursework'; workflow.submission.url = 'https://github.com/Secret/Coursework/pull/2';
  f.pair.repository = 'Secret/Coursework'; f.pair.prUrl = workflow.submission.url;
  await writeFile(path, JSON.stringify(workflow)); await writeFile(f.record, JSON.stringify(f.pair));
  assert.equal((await f.run()).eligible, true);
});

test('invalid UTF-8 in unused retained metadata cannot be admitted through replacement decoding', async t => {
  const f = await fixture(t);
  const bytes = Buffer.concat([Buffer.from(`${JSON.stringify(f.pair).slice(0, -1)},"unused":"`), Buffer.from([0x80]), Buffer.from('"}')]);
  await writeFile(f.record, bytes);
  const before = await files(f.root);
  assert.equal((await f.run()).status, 'BLOCKED');
  assert.deepEqual(await files(f.root), before);
});

test('a retained BOM byte change invalidates evidence even when decoded JSON is unchanged', async t => {
  const f = await fixture(t), original = await readFile(f.record);
  let changed = false;
  f.state.afterChecks = () => { if (!changed) { changed = true; writeFileSync(f.record, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original])); } };
  const report = await f.run();
  assert.equal(report.reasons[0].code, 'EVIDENCE_CHANGED');
  assert.equal(report.snapshot.observedOnly, true);
});
