import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  GITLEAKS_VERSION,
  RELEASE,
  applyExemptions,
  assertPinnedVersion,
  createSnapshot,
  installGitleaks,
  parseFindings,
  parseScanArgs,
  planScanRanges,
  readReport,
  removeSnapshot,
  revisionExists,
  runSecretScan,
  scanArgs,
  scanOnce,
  verifyChecksum,
} from '../../scripts/ci/scan-secrets.mjs';

const SYNTHETIC_SECRET = 'AKIAIOSFODNN7EXAMPLE-SYNTHETIC';
const finding = (overrides = {}) => ({
  RuleID: 'aws-access-token',
  Description: 'AWS Access Token',
  File: 'config/credentials.txt',
  StartLine: 3,
  Match: `aws_secret_access_key = "${SYNTHETIC_SECRET}"`,
  Secret: SYNTHETIC_SECRET,
  Commit: 'a'.repeat(40),
  ...overrides,
});
const report = (findings) => JSON.stringify(findings);
// The trusted inputs main() writes beside the scanned tree; only their identity matters here.
const trusted = { configPath: 'workspace/gitleaks.toml', ignorePath: 'workspace/gitleaks-ignore' };

test('refuses any Gitleaks binary that is not exactly the pinned version', () => {
  assert.equal(GITLEAKS_VERSION, '8.30.1');
  assert.equal(assertPinnedVersion('8.30.1'), '8.30.1');
  assert.equal(assertPinnedVersion('v8.30.1\n'), '8.30.1');
  for (const installed of ['8.18.4', 'v8.18.4', '8.30.2', '8.30.1-rc1', '', 'garbage']) {
    assert.throws(() => assertPinnedVersion(installed), /requires exactly 8\.30\.1/);
  }
});

test('installs only the pinned release verified against its checksum manifest', () => {
  const payload = Buffer.from('payload');
  const sha = createHash('sha256').update(payload).digest('hex');
  const manifest = `${'0'.repeat(64)}  other-asset.tar.gz\n${sha}  ${RELEASE.asset}\n`;
  assert.equal(RELEASE.baseUrl, `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}`);
  assert.equal(verifyChecksum({ bytes: payload, expected: sha }), true);
  assert.equal(verifyChecksum({ bytes: payload, expected: '0'.repeat(64) }), false);
  assert.throws(
    () => installGitleaks({ release: RELEASE, download: () => Buffer.from('tampered'), readChecksums: () => manifest }),
    /checksum mismatch/,
  );
  assert.throws(
    () => installGitleaks({ release: RELEASE, download: () => payload, readChecksums: () => 'no manifest rows' }),
    /does not list/,
  );
  assert.throws(
    () => installGitleaks({ release: RELEASE, download: () => { throw new Error('boom'); }, readChecksums: () => manifest }),
    /download failed/,
  );
  assert.throws(
    () => installGitleaks({ release: { ...RELEASE, version: '8.18.4' }, download: () => Buffer.alloc(0), readChecksums: () => manifest }),
    /Unsupported Gitleaks release/,
  );
  const installed = installGitleaks({ release: RELEASE, download: () => payload, readChecksums: () => manifest });
  assert.deepEqual(installed, { asset: RELEASE.asset, sha256: sha, version: GITLEAKS_VERSION });
});

test('plans a complete tree scan with an admitted range or an explicit unavailable range', () => {
  const head = 'c'.repeat(40);
  const base = 'd'.repeat(40);
  assert.deepEqual(planScanRanges({ event: 'pull_request', head, base }), {
    mode: 'tree-plus-range',
    ranges: [{ from: base, to: head }],
  });
  assert.deepEqual(planScanRanges({ event: 'push', head, before: base }), {
    mode: 'tree-plus-range',
    ranges: [{ from: base, to: head }],
  });
  assert.deepEqual(planScanRanges({ event: 'workflow_dispatch', head, before: '0'.repeat(40) }), {
    mode: 'tree-only-with-range-unavailable',
    ranges: [],
  });
  assert.deepEqual(planScanRanges({ event: 'push', head }), {
    mode: 'tree-only-with-range-unavailable',
    ranges: [],
  });
  assert.deepEqual(planScanRanges({ event: 'push', head, before: base, available: () => false }), {
    mode: 'tree-only-with-range-unavailable',
    ranges: [],
  });
  for (const unsafe of ['--upload-pack=evil', 'main..--output', 'HEAD^', 'x; rm -rf /', '$(id)', '']) {
    assert.throws(() => planScanRanges({ event: 'push', head: unsafe }), /revision/i);
    if (unsafe) assert.throws(() => planScanRanges({ event: 'push', head, before: unsafe }), /revision/i);
  }
  assert.deepEqual(planScanRanges({ event: 'push', head, before: '' }), { mode: 'tree-only-with-range-unavailable', ranges: [] });
  assert.throws(() => planScanRanges({ event: 'pull_request', head }), /revision/i);
  // A zero base is validated as a revision before the probe, so it fails closed as unsafe, not unavailable.
  assert.throws(() => planScanRanges({ event: 'pull_request', head, base: '0'.repeat(40), available: () => false }), /revision/i);
});

// The availability probe hands its argument to git argv, so an unsafe base must be rejected before the
// probe ever sees it rather than trusted to a caller that might shell out.
test('planScanRanges validates a pull-request base before probing availability', () => {
  const head = 'c'.repeat(40);
  const probed = [];
  const available = (rev) => { probed.push(rev); return true; };
  for (const unsafe of ['--upload-pack=evil', 'main..--output', 'HEAD^', 'x; rm -rf /', '$(id)']) {
    assert.throws(() => planScanRanges({ event: 'pull_request', head, base: unsafe, available }), /revision/i);
  }
  assert.deepEqual(probed, [], 'no unvalidated value reached the probe');
  assert.deepEqual(planScanRanges({ event: 'pull_request', head, base: 'd'.repeat(40), available }), {
    mode: 'tree-plus-range',
    ranges: [{ from: 'd'.repeat(40), to: head }],
  });
  assert.deepEqual(probed, ['d'.repeat(40)]);
});

test('builds structural arguments with full redaction and never a shell string', () => {
  const trusted = { configPath: 'workspace/gitleaks.toml', ignorePath: 'workspace/gitleaks-ignore' };
  const args = scanArgs({ snapshot: 'snapshot', from: 'a'.repeat(40), to: 'b'.repeat(40), reportPath: 'report.json', ...trusted });
  assert.ok(args.includes('--redact=100'));
  assert.ok(args.every((arg) => typeof arg === 'string' && !/[\r\n]/.test(arg)));
  assert.ok(args.includes(`${'a'.repeat(40)}..${'b'.repeat(40)}`));
  assert.deepEqual(args.slice(0, 2), ['git', 'snapshot']);
  const tree = scanArgs({ snapshot: 'snapshot', reportPath: 'report.json', ...trusted });
  assert.deepEqual(tree.slice(0, 2), ['dir', 'snapshot']);
  assert.ok(!tree.includes('--log-opts'));
  assert.ok(tree.includes('--redact=100'));
});

// The candidate controls the checked-out tree, so it controls a .gitleaks.toml, a .gitleaksignore and
// inline allow comments. Each of those alone used to turn a real finding green; the three flags are the
// only thing standing between the candidate and its own required lane.
test('always pins the trusted config, ignore path and inline-allow refusal in both scan forms', () => {
  const configPath = join(tmpdir(), 'gitleaks-scan-trusted', 'gitleaks.toml');
  const ignorePath = join(tmpdir(), 'gitleaks-scan-trusted', 'gitleaks-ignore');
  for (const range of [{}, { from: 'a'.repeat(40), to: 'b'.repeat(40) }]) {
    const args = scanArgs({ snapshot: 'snapshot', reportPath: 'report.json', configPath, ignorePath, ...range });
    assert.equal(args[args.indexOf('--config') + 1], configPath);
    assert.equal(args[args.indexOf('--gitleaks-ignore-path') + 1], ignorePath);
    assert.ok(args.includes('--ignore-gitleaks-allow'));
    assert.equal(args.filter((arg) => arg === '--config').length, 1);
    assert.equal(args.filter((arg) => arg === '--ignore-gitleaks-allow').length, 1);
  }
});

// The public arg list has no candidate-controlled slot, so there is no spelling that drops a flag:
// only omission of the trusted parameter is left, and that refuses instead of running unpinned.
test('refuses to build a scan argv without the trusted config and ignore inputs', () => {
  const reportPath = 'report.json';
  for (const missing of [
    {},
    { configPath: 'workspace/gitleaks.toml' },
    { ignorePath: 'workspace/gitleaks-ignore' },
    { configPath: '', ignorePath: 'workspace/gitleaks-ignore' },
    { configPath: 'workspace/gitleaks.toml', ignorePath: '' },
  ]) {
    assert.throws(() => scanArgs({ snapshot: 'snapshot', reportPath, ...missing }), /trusted Gitleaks config and ignore path/);
  }
});

test('reports unchanged-tree, added-then-deleted and clean scans with allowlisted findings only', () => {
  const head = 'c'.repeat(40);
  const base = 'd'.repeat(40);
  const plan = planScanRanges({ event: 'pull_request', head, base });
  const run = ({ kind }) => ({
    status: 1,
    report: kind === 'tree' ? report([finding()]) : report([finding({ Commit: 'e'.repeat(40) })]),
  });
  const result = runSecretScan({ plan, snapshot: 'snapshot', scan: run });
  assert.equal(result.mode, 'tree-plus-range');
  assert.equal(result.findings.length, 2);
  for (const item of result.findings) {
    assert.deepEqual(Object.keys(item).sort(), ['commit', 'line', 'path', 'ruleId']);
  }
  assert.ok(!JSON.stringify(result).includes(SYNTHETIC_SECRET), 'raw match/secret fields are dropped');

  const clean = runSecretScan({ plan, snapshot: 'snapshot', scan: () => ({ status: 0, report: '[]' }) });
  assert.deepEqual(clean, { mode: 'tree-plus-range', findings: [] });

  const fallback = planScanRanges({ event: 'push', head });
  let calls = 0;
  const unchanged = runSecretScan({
    plan: fallback,
    snapshot: 'snapshot',
    scan: () => { calls += 1; return { status: 1, report: report([finding()]) }; },
  });
  assert.equal(unchanged.mode, 'tree-only-with-range-unavailable');
  assert.equal(calls, 1, 'the complete tree scan still runs when the range is unavailable');
  assert.equal(unchanged.findings.length, 1);
});

test('a requested scan failure is never a clean report', () => {
  const plan = planScanRanges({ event: 'push', head: 'c'.repeat(40), before: 'd'.repeat(40) });
  const cases = [
    [{ status: 2, report: '[]' }, /non-report exit status/],
    [{ status: 0, report: undefined }, /did not produce a report/],
    [{ status: 0, report: '{not json' }, /malformed output/],
    [{ status: 0, report: '{"findings":[]}' }, /malformed output/],
    [{ status: 0, report: report([{ RuleID: 'x' }]) }, /malformed output/],
    [{ status: 0, report: report([finding({ RuleID: `bad${SYNTHETIC_SECRET}` })]) }, /redact/i],
    [{ status: 0, report: report([finding({ File: `x\u0000${SYNTHETIC_SECRET}` })]) }, /redact/i],
    [{ status: 0, report: report([finding({ Commit: `nope${SYNTHETIC_SECRET}` })]) }, /redact/i],
  ];
  for (const [result, expected] of cases) {
    assert.throws(
      () => runSecretScan({ plan, snapshot: 'snapshot', scan: () => result }),
      (error) => expected.test(error.message) && !error.message.includes(SYNTHETIC_SECRET),
    );
  }
  assert.equal(parseFindings({ status: 1, report: report([finding()]) }).length, 1, 'exit 1 means findings were reported');
  assert.throws(() => parseFindings({ status: 2, report: '[]' }), /non-report exit status/);
});

test('bounded capture rejects an oversized report and maps timeouts to execution failures', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gitleaks-bounded-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'report.json');
  await writeFile(path, '[]');
  assert.equal(readReport(path, 2), '[]');
  assert.throws(() => readReport(path, 1), /bounded size limit/);
  const timeout = Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' });
  assert.throws(
    () => scanOnce({ kind: 'tree', snapshot: 'snapshot', binary: 'gitleaks', workdir: directory, ...trusted, execute: () => { throw timeout; } }),
    /timed out/,
  );
  assert.throws(
    () => scanOnce({ kind: 'tree', snapshot: 'snapshot', binary: 'gitleaks', workdir: directory, ...trusted, execute: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } }),
    /could not be executed/,
  );
  const args = scanOnce({
    kind: 'tree',
    snapshot: 'snapshot',
    binary: 'gitleaks',
    workdir: directory,
    ...trusted,
    execute: ({ reportPath }) => { writeFileSync(reportPath, '[]'); return { status: 0, report: readReport(reportPath) }; },
  }).args;
  assert.ok(args.includes('--redact=100'));
  assert.equal(args[args.indexOf('--config') + 1], trusted.configPath, 'scanOnce forwards the trusted config');
  assert.equal(args[args.indexOf('--gitleaks-ignore-path') + 1], trusted.ignorePath, 'scanOnce forwards the trusted ignore path');
  assert.throws(() => readReport(join(directory, 'absent.json'), 1024), /could not be read/);
});

// A `dir` scan reports the snapshot prefix in every File; reporting it would leak a random temp path
// and make every reviewed exemption unmatchable. A path outside the snapshot fails closed.
test('reports snapshot-relative paths and rejects a path that escapes the snapshot', () => {
  const snapshot = '/tmp/gitleaks-scan-7Qcz38/tree';
  const parse = (file) => parseFindings({ status: 1, report: report([finding({ File: file })]) }, snapshot);
  assert.deepEqual(parse(`${snapshot}/src/x.ts`).map((item) => item.path), ['src/x.ts']);
  assert.deepEqual(parse('src/x.ts').map((item) => item.path), ['src/x.ts'], 'a git scan is already repo-relative');
  for (const escaped of [`${snapshot}/../outside.ts`, '/etc/passwd', 'a/../../b.ts']) {
    assert.throws(() => parse(escaped), /malformed output/, `refuses ${escaped}`);
  }
  // Redaction still wins over the path rejection: the secret never reaches the message.
  assert.throws(
    () => parseFindings({ status: 1, report: report([finding({ File: `/etc/${SYNTHETIC_SECRET}` })]) }, snapshot),
    (error) => /redact/i.test(error.message) && !error.message.includes(SYNTHETIC_SECRET),
  );
});

// The shipped exemption list is candidate-controlled by design: a PR adding a secret also adds an
// visible exemption line to its own diff. This pins it to the reviewed synthetic findings, so a
// blanket allowlist or a drifted path cannot sneak through.
test('shipped exemptions validate and clear exactly the reviewed synthetic findings', () => {
  const shipped = JSON.parse(readFileSync(resolve('config/secret-scan-exemptions.json'), 'utf8'));
  const reviewed = [
    ['generic-api-key', 'src/contracts/foundation/uc03/v02/admission/attempt-outcome.ts', 33],
    ['generic-api-key', 'src/contracts/foundation/uc03/v02/admission/attempt-outcome.ts', 68],
    ['generic-api-key', 'tests/runtime/uc01/assess.test.ts', 195],
    ['generic-api-key', 'tests/runtime/uc01/intake.test.ts', 23],
    ['generic-api-key', 'tests/runtime/unit/docker-workspace.test.ts', 882],
    ['generic-api-key', 'tests/runtime/unit/docker-workspace.test.ts', 886],
    ['generic-api-key', 'tests/runtime/unit/docker-workspace.test.ts', 1176],
    ['generic-api-key', 'tests/runtime/unit/docker-workspace.test.ts', 1775],
    ['github-pat', 'tests/runtime/unit/docker-workspace.test.ts', 1177],
    ['github-pat', 'tests/runtime/unit/docker-workspace.test.ts', 1774],
    ['private-key', 'tests/runtime/unit/telemetry.test.ts', 633],
    ['generic-api-key', 'tests/runtime/unit/telemetry.test.ts', 343],
    ['generic-api-key', 'tests/runtime/unit/uc03-report.test.ts', 316],
    ['generic-api-key', 'tests/runtime/unit/uc03-report.test.ts', 806],
    ['generic-api-key', 'tests/runtime/unit/uc03-report.test.ts', 1131],
    ['generic-api-key', 'tests/runtime/unit/model.test.ts', 439],
    ['generic-api-key', 'tests/runtime/unit/model.test.ts', 524],
    ['generic-api-key', 'tests/runtime/security/uc03-isolation.test.ts', 876],
    ['github-pat', 'tests/runtime/security/uc03-isolation.test.ts', 879],
    ['generic-api-key', 'tests/runtime/unit/repository-tools.test.ts', 624],
  ];
  const findings = reviewed.map(([ruleId, path, line]) => ({ ruleId, path, line, commit: '' }));
  // applyExemptions validates every entry (exact path, reason, commit) and rejects duplicates.
  assert.deepEqual(applyExemptions(findings, shipped), []);
  assert.deepEqual(
    shipped.map((entry) => [entry.ruleId, entry.path, entry.line]),
    reviewed,
    'the shipped list covers exactly the reviewed findings, no blanket allowlist',
  );
  const nearby = applyExemptions([...findings, { ruleId: 'generic-api-key', path: 'tests/runtime/unit/docker-workspace.test.ts', line: 883, commit: '' }], shipped);
  assert.deepEqual(nearby.map((item) => item.line), [883], 'a nearby unlisted finding still fails');
});

test('exemptions bind exact synthetic findings and never cover nearby unapproved ones', () => {
  const head = 'c'.repeat(40);
  const plan = planScanRanges({ event: 'push', head });
  const exempted = finding({ File: 'tests/fixtures/synthetic.env.example', StartLine: 7, Commit: '' });
  const nearby = finding({ File: 'tests/fixtures/synthetic.env.example', StartLine: 8, Commit: '' });
  const exemptions = [{ ruleId: 'aws-access-token', path: 'tests/fixtures/synthetic.env.example', line: 7, commit: '', reason: 'Synthetic fixture literal reviewed for scanner tests.' }];
  const exact = runSecretScan({ plan, snapshot: 'snapshot', scan: () => ({ status: 1, report: report([exempted]) }), exemptions });
  assert.deepEqual(exact.findings, []);
  const withNearby = runSecretScan({ plan, snapshot: 'snapshot', scan: () => ({ status: 1, report: report([exempted, nearby]) }), exemptions });
  assert.deepEqual(withNearby.findings.map((item) => item.line), [8]);
  for (const bad of [
    { ...exemptions[0], reason: '' },
    { ...exemptions[0], path: 'tests/' },
    { ...exemptions[0], path: 'tests/**' },
    { ...exemptions[0], line: 0 },
  ]) {
    assert.throws(() => applyExemptions([], [bad]), /exemption/i);
  }
  assert.throws(() => applyExemptions([], [exemptions[0], { ...exemptions[0] }]), /duplicate/i);
});

// The workflow builds this argv by hand, so the wiring itself is what needs pinning: a push passes the
// pre-push revision as --before, and reading it as --base silently disables the only add-then-delete
// range scan there is.
test('the workflow argv keeps push and pull-request revisions distinct', () => {
  const head = 'c'.repeat(40);
  const base = 'd'.repeat(40);

  const pullRequest = parseScanArgs(['--event', 'pull_request', '--head', head, '--base', base]);
  assert.equal(pullRequest.before, undefined);
  assert.deepEqual(planScanRanges(pullRequest).ranges, [{ from: base, to: head }]);

  const push = parseScanArgs(['--event', 'push', '--head', head, '--before', base]);
  assert.equal(push.base, undefined);
  assert.deepEqual(planScanRanges(push).ranges, [{ from: base, to: head }], 'a push range is admitted, not skipped');

  // The defect this pins: a push handed the pre-push revision as --base still planned no range at all.
  const miswired = parseScanArgs(['--event', 'push', '--head', head, '--base', base]);
  assert.deepEqual(planScanRanges(miswired).ranges, [], 'the miswiring this test exists to prevent');
});

// Both scans report into one workspace, so a shared report name lets a failed range scan read the tree
// scan's stale report. The name is derived from the kind, so the two can never collide.
test('tree and range scans never share a report path', () => {
  const directory = join(tmpdir(), 'scan-report-names');
  const paths = ['tree', 'range'].map((kind) => {
    const { args } = scanOnce({ kind, snapshot: 'snapshot', reportDir: directory, binary: 'gitleaks', workdir: directory, ...trusted, execute: () => ({ status: 0, report: '[]' }) });
    return args[args.indexOf('--report-path') + 1];
  });
  assert.equal(new Set(paths).size, 2, 'a stale tree report cannot be read as a range report');
});

test('snapshot creation checks out the admitted head in isolation', async (t) => {  const root = await mkdtemp(join(tmpdir(), 'gitleaks-snapshot-'));
  const outside = await mkdtemp(join(tmpdir(), 'gitleaks-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', [...args], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--allow-empty', '--quiet', '-m', 'root');
  await writeFile(join(root, 'unchanged.txt'), 'SENTINEL\n');
  git('add', 'unchanged.txt');
  git('-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--quiet', '-m', 'add');
  // A candidate .gitleaksignore is read by Gitleaks even with --gitleaks-ignore-path, so the snapshot
  // must not carry one; the source checkout keeps it because the snapshot is a throwaway worktree.
  await writeFile(join(root, '.gitleaksignore'), 'deadbeef\n');
  git('add', '.gitleaksignore');
  git('-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--quiet', '-m', 'ignore');
  const head = git('rev-parse', 'HEAD');
  const directory = join(outside, 'tree');
  createSnapshot({ root, head, directory });
  assert.equal(existsSync(join(directory, '.gitleaksignore')), false, 'a checked-out ignore file is removed');
  assert.equal(existsSync(join(root, '.gitleaksignore')), true, 'the candidate checkout itself is untouched');
  const status = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout.trim(), head);
  removeSnapshot({ root, directory });
  assert.notEqual(spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).status, 0);
});

test('snapshot creation removes a symbolic-link .gitleaksignore without changing its target', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gitleaks-linked-ignore-'));
  const outside = await mkdtemp(join(tmpdir(), 'gitleaks-linked-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  await writeFile(join(root, 'ignore.txt'), 'deadbeef\n');
  try {
    await symlink('ignore.txt', join(root, '.gitleaksignore'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('File symlinks unavailable on this host');
    throw error;
  }
  git('init', '--quiet');
  git('config', 'core.symlinks', 'true');
  git('config', 'core.autocrlf', 'false');
  git('add', 'ignore.txt', '.gitleaksignore');
  git('-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--quiet', '-m', 'linked ignore');
  const directory = join(outside, 'tree');
  try {
    createSnapshot({ root, head: git('rev-parse', 'HEAD'), directory });
    await assert.rejects(lstat(join(directory, '.gitleaksignore')), { code: 'ENOENT' });
    assert.equal(readFileSync(join(directory, 'ignore.txt'), 'utf8'), 'deadbeef\n');
    assert.ok((await lstat(join(root, '.gitleaksignore'))).isSymbolicLink(), 'the source link is untouched');
    assert.equal(readFileSync(join(root, 'ignore.txt'), 'utf8'), 'deadbeef\n');
  } finally {
    removeSnapshot({ root, directory });
  }
});

// The base of a pull_request scan is the base branch tip, so a PR branch that is behind has a valid
// base..head range without an ancestor relationship. Existence is the only property that matters.
test('revisionExists accepts a real commit that is not an ancestor and rejects an unknown sha', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gitleaks-revision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (message) => {
    git('-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--allow-empty', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--quiet');
  const shared = commit('shared');
  const head = commit('head');
  git('checkout', '--quiet', '-b', 'diverged', shared);
  const other = commit('other');
  assert.equal(revisionExists(root, head), true);
  assert.equal(revisionExists(root, other), true);
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', other, head], { cwd: root, windowsHide: true }).status, 1, 'the two revisions really diverged');
  assert.equal(revisionExists(root, 'f'.repeat(40)), false);
  assert.equal(revisionExists(root, 'nope'), false);
});

test('CLI refuses usage errors and an unexecutable local binary before scanning', async (t) => {
  const usage = spawnSync(process.execPath, [resolve('scripts/ci/scan-secrets.mjs'), '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage: node scripts\/ci\/scan-secrets\.mjs/);

  const root = await mkdtemp(join(tmpdir(), 'gitleaks-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--allow-empty', '--quiet', '-m', 'root');
  const head = git('rev-parse', 'HEAD');
  const scan = spawnSync(process.execPath, [
    resolve('scripts/ci/scan-secrets.mjs'), '--event', 'push', '--head', head, '--root', root, '--gitleaks', join(root, 'absent-gitleaks'),
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(scan.status, 1);
  assert.equal(scan.stdout, '', 'no report is emitted when the binary cannot be probed');
  assert.doesNotMatch(scan.stderr, /tree-plus-range/);
});
