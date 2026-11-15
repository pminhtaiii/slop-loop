/** T057: port rule, staged-tree index scanning, error codes and the host.json template. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runRealTierScanCli } from '../../../src/cli/real-tier-scan.ts';
import { scanAll, scanDirectory, scanRange, scanStaged, type ScanGit, type ScanResult } from '../../../src/runtime/real-tier-endpoint-scan.ts';
import { loadRealTierProfile, type RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';

// RFC 5737 / `.invalid` sentinels and a synthetic key only: no real host, port or key.
const OUTSIDE = mkdtempSync(join(tmpdir(), 't057b-outside-'));
const REPO = mkdtempSync(join(tmpdir(), 't057b-repository-'));
const BASE = mkdtempSync(join(tmpdir(), 't057b-dir-'));
const KEY = 'sentinel-key-0123456789abcdef';
const MODEL = 'po/deepseek-ai/deepseek-v4.1-flash-1017';
const HREF = 'http://192.0.2.10:54321/v1/messages';
const PRIVATE = 'http://192.0.2.12:54321/v1/messages';
const sha = (seed: string): string => sha256Text(seed);
/** A strong key derived in the test: the loader refuses weak ones, and the value is itself a needle. */
const DIGEST_KEY = sha('t057b-endpoint-digest-key');

const PROVIDER = { endpoint: HREF, allowInsecureHttp: true, endpointDigestKey: DIGEST_KEY, model: MODEL, mode: 'nonstreaming', timeoutMs: 60000 } as const;
const PRICING = { pricingId: 'placeholder-unverified', denominator: 1000000, inputRate: 2000000, cacheRate: 2000000, outputRate: 8000000, overheadRate: 0 };
const LIMITS = {
  totalModelCalls: 24,
  inputTokensPerRequest: 32768,
  outputTokensPerRequest: 8192,
  providerTimeoutMs: 60000,
  activeExecutionMs: 900000,
  repairs: 2,
  reviewerIterations: 2,
  materialReplans: 3,
  commandTimeoutMs: 60000,
  outputBytes: 1048576,
  memoryBytes: 1073741824,
  cpus: 1,
  processes: 128,
};
const IMAGE = { label: 'uc03-pytest:real-tier', imageId: `sha256:${sha('image')}`, base: `python:3.12-alpine@sha256:${sha('base')}`, platform: 'linux/amd64', user: '1000:1000' };

const defaults = (): Record<string, unknown> => ({
  schema: 'uc03-real-tier-profile/1',
  campaignId: 'uc03-real-tier-2026-11',
  stateRoot: join(OUTSIDE, 'state'),
  provider: { ...PROVIDER },
  pricing: { ...PRICING },
  runLimits: { perRunInputTokens: 400000, perRunOutputTokens: 80000 },
  limits: { ...LIMITS },
  image: { ...IMAGE },
  catalog: { path: join(REPO, 'fixtures', 'uc03', 'catalog.json') },
  artifacts: { retainRoot: join(OUTSIDE, 'artifacts'), retainRawStreams: false },
  approvalPolicy: { profileVersion: 'real-tier-2026-11-14' },
});

let profiles = 0;

function envOf(patch: Record<string, unknown> = {}): RealTierEnvironment {
  const file = join(OUTSIDE, `profile-${profiles++}.json`);
  writeFileSync(file, JSON.stringify({ ...defaults(), ...patch }), 'utf8');
  return { UC03_REAL_TIER_PROFILE: file, ANTHROPIC_API_KEY: KEY };
}

let cases = 0;

function scanContent(content: string, env: RealTierEnvironment): ScanResult {
  const dir = join(BASE, `case-${cases++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'), content, 'utf8');
  return scanDirectory(dir, { env, repositoryRoot: REPO });
}

function quiet(result: ScanResult): void {
  for (const forbidden of ['192.0.2.10', '192.0.2.12', '54321', KEY, DIGEST_KEY, 'model.invalid']) {
    assert.equal(result.output.includes(forbidden), false, 'output must not echo a needle or sentinel');
  }
  assert.doesNotMatch(result.output, /fatal|matched/iu);
}

const leakCount = (result: ScanResult): number => result.output.split('\n').filter(line => / (?:ENDPOINT|CREDENTIAL)_LEAK$/u.test(line)).length;

test('the explicit port is a needle after a host-like token and as a port key value', async () => {
  // The endpoint host is deliberately absent from every row, so only the port rule can flag them.
  const env = envOf({ provider: { ...PROVIDER, endpoint: 'http://evidence.invalid:54321/v1/messages' } });
  const hits = ['model.invalid:54321', '192.0.2.10%3A54321', 'providerPort = 54321', '"port": 54321', "port: '54321'"];
  for (const content of hits) {
    const result = scanContent(`${content}\n`, env);
    assert.equal(result.exitCode, 1, content);
    assert.equal(leakCount(result), 1, content);
    assert.match(result.output, /^result\.json:1 ENDPOINT_LEAK\nSCAN_LEAK$/u, content);
    quiet(result);
  }

  const misses = ['the run used 54321 tokens', 'identifier 543210', 'identifier 154321', 'line 12:54321', ':54321'];
  for (const content of misses) {
    const result = scanContent(`${content}\n`, env);
    assert.equal(result.exitCode, 0, content);
    assert.equal(result.output, 'SCAN_CLEAN', content);
  }
});

test('ports 443 and 80 are never needles', async () => {
  const env = envOf({ provider: { ...PROVIDER, endpoint: 'https://model.invalid/v1/messages', allowInsecureHttp: false } });
  const result = scanContent("proxy 443\nproviderPort = 443\nport: '80'\n", env);
  assert.equal(result.exitCode, 0);
});

const git = (cwd: string, args: readonly string[]): string => execFileSync('git', ['-c', 'user.name=t057', '-c', 'user.email=t057@example.invalid', ...args], { cwd, encoding: 'utf8' });

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 't057b-staged-'));
  git(dir, ['init', '-q']);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content, 'utf8');
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  return dir;
}

const staged = (dir: string): Promise<ScanResult> => scanStaged({ env: envOf(), cwd: dir, repositoryRoot: dir });

test('a clean staged deletion and a clean rename exit 0', async () => {
  const deletion = repoWith({ 'a.txt': 'clean\n' });
  git(deletion, ['rm', '-q', 'a.txt']);
  const deleted = await staged(deletion);
  assert.equal(deleted.exitCode, 0);
  assert.equal(deleted.output, 'SCAN_CLEAN');

  const rename = repoWith({ 'a.txt': 'clean\n' });
  git(rename, ['mv', 'a.txt', 'b.txt']);
  const renamed = await staged(rename);
  assert.equal(renamed.exitCode, 0);
  assert.equal(renamed.output, 'SCAN_CLEAN');
});

test('a rename to a needle-bearing name or with leaking new content exits 1', async () => {
  const named = repoWith({ 'a.txt': 'clean\n' });
  mkdirSync(join(named, 'evidence', '192.0.2.10'), { recursive: true });
  git(named, ['mv', 'a.txt', 'evidence/192.0.2.10/result.txt']);
  const namedResult = await staged(named);
  assert.equal(namedResult.exitCode, 1);
  assert.match(namedResult.output, /^path-hmac:[a-f0-9]{12}:0 ENDPOINT_LEAK\nSCAN_LEAK$/u);
  quiet(namedResult);

  const content = repoWith({ 'a.txt': 'clean\n' });
  git(content, ['mv', 'a.txt', 'b.txt']);
  writeFileSync(join(content, 'b.txt'), 'clean\nproviderPort = 54321\n', 'utf8');
  git(content, ['add', 'b.txt']);
  const contentResult = await staged(content);
  assert.equal(contentResult.exitCode, 1);
  assert.match(contentResult.output, /^b\.txt:2 ENDPOINT_LEAK\nSCAN_LEAK$/u);
  quiet(contentResult);
});

test('the staged mode applies the same path rules as the directory mode', async () => {
  /** A committed base, then one new file added to the index: only that entry is a candidate. */
  const stage = (name: string, content: string): string => {
    const dir = repoWith({ 'a.txt': 'clean\n' });
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content, 'utf8');
    git(dir, ['add', '-A']);
    return dir;
  };
  const hostPath = await staged(stage('evidence/192.0.2.10/result.json', '{"outcome":"pass"}\n'));
  assert.equal(hostPath.exitCode, 1);
  assert.match(hostPath.output, /^path-hmac:[a-f0-9]{12}:0 ENDPOINT_LEAK\nSCAN_LEAK$/u);
  quiet(hostPath);

  const credentialPath = await staged(stage(`evidence/${KEY}.json`, '{"outcome":"pass"}\n'));
  assert.equal(credentialPath.exitCode, 1);
  assert.match(credentialPath.output, /^path-hmac:[a-f0-9]{12}:0 CREDENTIAL_LEAK\nSCAN_LEAK$/u);
  quiet(credentialPath);

  const both = await staged(stage('evidence/192.0.2.10/leak.json', '{"outcome":"pass"}\nproviderPort = 54321\n'));
  assert.equal(both.exitCode, 1);
  assert.match(both.output, /^path-hmac:[a-f0-9]{12}:0 ENDPOINT_LEAK\npath-hmac:[a-f0-9]{12}:2 ENDPOINT_LEAK\nSCAN_LEAK$/u);
  quiet(both);

  const cleanName = await staged(stage('evidence/result.json', 'clean\n'));
  assert.equal(cleanName.exitCode, 0, 'a clean file under a clean path stays clean');
  assert.equal(cleanName.output, 'SCAN_CLEAN');
});

test('a staged content leak under a clean path prints the plain relative path', async () => {
  const dir = repoWith({ 'a.txt': 'clean\n' });
  writeFileSync(join(dir, 'a.txt'), `${HREF}\n`, 'utf8');
  git(dir, ['add', '-A']);
  const result = await staged(dir);
  assert.equal(result.exitCode, 1);
  assert.equal(result.output, 'a.txt:1 ENDPOINT_LEAK\nSCAN_LEAK');
  quiet(result);
});

test('a staged path containing the digest key is hashed under that key', async () => {
  const dir = repoWith({ 'a.txt': 'clean\n' });
  mkdirSync(join(dir, DIGEST_KEY), { recursive: true });
  writeFileSync(join(dir, DIGEST_KEY, 'result.json'), '{"outcome":"pass"}\n', 'utf8');
  git(dir, ['add', '-A']);
  const result = await staged(dir);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /^path-hmac:[a-f0-9]{12}:0 DIGEST_KEY_LEAK\nSCAN_LEAK$/u);
  quiet(result);
});

test('a blob read failure on an extant index path is SCAN_ERROR with no child error text', async () => {
  const dir = repoWith({ 'a.txt': 'clean\n' });
  const gitDouble: ScanGit = args => Promise.resolve(args[0] === 'diff' ? { ok: true, stdout: 'a.txt\0' } : { ok: false });
  const result = await scanStaged({ env: envOf(), cwd: dir, repositoryRoot: dir, git: gitDouble });
  assert.equal(result.exitCode, 2);
  assert.match(result.output, /^SCAN_ERROR [a-z-]+$/u);
  assert.equal(result.output.includes('a.txt'), false);
});

test('an unreadable profile, a git failure and an unresolvable endpoint are SCAN_ERROR', async () => {
  const unreadable = await scanDirectory(BASE, { env: { UC03_REAL_TIER_PROFILE: join(OUTSIDE, 'absent.json'), ANTHROPIC_API_KEY: KEY }, repositoryRoot: REPO });
  assert.equal(unreadable.exitCode, 2);
  assert.match(unreadable.output, /^SCAN_ERROR [A-Za-z-]+$/u);

  const unreachable = mkdtempSync(join(tmpdir(), 't057b-not-a-repo-'));
  const gitFailure = await scanStaged({ env: envOf(), cwd: unreachable, repositoryRoot: unreachable });
  assert.equal(gitFailure.exitCode, 2);
  assert.match(gitFailure.output, /^SCAN_ERROR [A-Za-z-]+$/u);

  const noEndpoint = await scanDirectory(BASE, { env: envOf({ provider: { ...PROVIDER, endpoint: 'not-a-url' } }), repositoryRoot: REPO });
  assert.equal(noEndpoint.exitCode, 2);
  assert.match(noEndpoint.output, /^SCAN_ERROR [A-Za-z-]+$/u);
});

test('unknown or incomplete arguments are SCAN_ERROR and never echo argv', async () => {
  for (const args of [['--bogus'], ['--dir'], ['--staged', '--dir', BASE]]) {
    const result = await runRealTierScanCli(args, { env: envOf(), repositoryRoot: REPO });
    assert.equal(result.exitCode, 2, args.join(' '));
    assert.equal(result.output, 'SCAN_ERROR arguments');
  }
});

test('--print-host-template prints the host.json shape with computed digests and no endpoint', async () => {
  const env = envOf();
  const result = await runRealTierScanCli(['--print-host-template'], { env, repositoryRoot: REPO });
  assert.equal(result.exitCode, 0);
  const template = JSON.parse(result.output) as Record<string, unknown>;
  assert.deepEqual(Object.keys(template).sort(), ['adapterVersions', 'assembly', 'configDigest', 'contractVersion', 'pricingDigest', 'profileDigest', 'profileId', 'requestedModel', 'revisions']);

  const loaded = loadRealTierProfile(env, { repositoryRoot: REPO });
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(template.profileDigest, `sha256:${loaded.value.profileDigest}`);
  assert.equal(template.pricingDigest, `sha256:${sha256Text(JSON.stringify(loaded.value.pricing))}`);
  assert.match(String(template.configDigest), /^sha256:[a-f0-9]{64}$/u);
  assert.equal(template.requestedModel, MODEL);
  assert.deepEqual(template.adapterVersions, ['uc03-real-tier/1']);
  assert.equal(template.contractVersion, 'uc03-host-composition/2');
  assert.equal(template.assembly, 'dist/src/runtime/real-tier-assembly.js');
  const revisions = template.revisions as Record<string, string>;
  assert.equal(Object.keys(revisions).length > 0, true);
  assert.equal(
    Object.values(revisions).every(revision => /^[a-f0-9]{40,64}$/u.test(revision)),
    true,
  );
  quiet(result);
});

test('the staged mode CLI scans the repository index and stays quiet', async () => {
  const dir = repoWith({ 'a.txt': 'clean\n' });
  const result = await runRealTierScanCli(['--staged'], { env: envOf(), cwd: dir, repositoryRoot: dir });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'SCAN_CLEAN');
});

test('the CLI wires --all and --range base', async () => {
  const dir = repoWith({ 'evidence/result.json': 'served by 192.0.2.12\n' });
  const all = await runRealTierScanCli(['--all'], { env: grownEnv(), cwd: dir, repositoryRoot: dir });
  assert.equal(all.exitCode, 1);
  assert.equal(all.output, 'evidence/result.json:1 ENDPOINT_LEAK\nSCAN_LEAK');

  const range = await runRealTierScanCli(['--range', 'HEAD'], { env: grownEnv(), cwd: dir, repositoryRoot: dir });
  assert.equal(range.exitCode, 0);
  assert.equal(range.output, 'SCAN_CLEAN', 'nothing since HEAD');
});

/** A profile whose needle set gained a private endpoint after `base` was committed. */
const grownEnv = (): RealTierEnvironment => envOf({ privacy: { additionalPrivateEndpoints: [PRIVATE] } });

test('a tunnel profile scans the listed private endpoint in the staged index', async () => {
  const tunnel = (): RealTierEnvironment =>
    envOf({ provider: { ...PROVIDER, endpoint: 'http://127.0.0.1:54321/v1/messages' }, privacy: { additionalPrivateEndpoints: ['http://192.0.2.10:8080/v1/messages'] } });
  for (const content of ['served by 192.0.2.10\n', 'endpoint 192.0.2.10:8080\n']) {
    const dir = repoWith({ 'a.txt': 'clean\n' });
    writeFileSync(join(dir, 'a.txt'), content, 'utf8');
    git(dir, ['add', '-A']);
    const result = await scanStaged({ env: tunnel(), cwd: dir, repositoryRoot: dir });
    assert.equal(result.exitCode, 1, content);
    assert.equal(result.output, 'a.txt:1 ENDPOINT_LEAK\nSCAN_LEAK', content);
    quiet(result);
  }

  const missing = repoWith({ 'a.txt': 'clean\n' });
  const result = await scanStaged({ env: envOf({ provider: { ...PROVIDER, endpoint: 'http://127.0.0.1:54321/v1/messages' } }), cwd: missing, repositoryRoot: missing });
  assert.equal(result.exitCode, 2);
  assert.equal(result.output, 'SCAN_ERROR tunnel-endpoint-missing');
});

test('--all audits the whole index while --staged sees only the candidate', async () => {
  const dir = repoWith({ 'evidence/result.json': 'served by 192.0.2.12\n' });
  const stagedResult = await scanStaged({ env: grownEnv(), cwd: dir, repositoryRoot: dir });
  assert.equal(stagedResult.exitCode, 0, 'the unchanged tracked file is not a candidate');

  const allResult = await scanAll({ env: grownEnv(), cwd: dir, repositoryRoot: dir });
  assert.equal(allResult.exitCode, 1);
  assert.equal(allResult.output, 'evidence/result.json:1 ENDPOINT_LEAK\nSCAN_LEAK');
  quiet(allResult);

  const clean = repoWith({ 'a.txt': 'clean\n' });
  const cleanAll = await scanAll({ env: envOf(), cwd: clean, repositoryRoot: clean });
  assert.equal(cleanAll.exitCode, 0);
  assert.equal(cleanAll.output, 'SCAN_CLEAN');
});

test('--range scans every commit the base does not contain, including removed bytes and messages', async () => {
  // The host is added and then removed, so only history keeps it: --all sees a clean index.
  const removed = repoWith({ 'a.txt': 'clean\n' });
  writeFileSync(join(removed, 'a.txt'), 'served by 192.0.2.12\n', 'utf8');
  git(removed, ['commit', '-qam', 'add host']);
  git(removed, ['checkout', '-q', 'HEAD~1', '--', 'a.txt']);
  git(removed, ['commit', '-qam', 'remove host']);
  assert.equal((await scanAll({ env: grownEnv(), cwd: removed, repositoryRoot: removed })).exitCode, 0, 'the index is clean');

  const history = await scanRange({ env: grownEnv(), cwd: removed, repositoryRoot: removed }, 'HEAD~2');
  assert.equal(history.exitCode, 1);
  assert.match(history.output, /^a\.txt:1 ENDPOINT_LEAK\nSCAN_LEAK$/u);
  quiet(history);

  const message = repoWith({ 'a.txt': 'clean\n' });
  git(message, ['commit', '-q', '--allow-empty', '-m', 'served by 192.0.2.12']);
  const head = git(message, ['rev-parse', 'HEAD']).trim();
  const messageResult = await scanRange({ env: grownEnv(), cwd: message, repositoryRoot: message }, 'HEAD~1');
  assert.equal(messageResult.exitCode, 1);
  assert.equal(messageResult.output, `commit-message:${head}:1 ENDPOINT_LEAK\nSCAN_LEAK`);
  quiet(messageResult);

  const clean = repoWith({ 'a.txt': 'clean\n' });
  writeFileSync(join(clean, 'b.txt'), 'still clean\n', 'utf8');
  git(clean, ['add', '-A']);
  git(clean, ['commit', '-qm', 'clean step']);
  const cleanRange = await scanRange({ env: envOf(), cwd: clean, repositoryRoot: clean }, 'HEAD~1');
  assert.equal(cleanRange.exitCode, 0);
  assert.equal(cleanRange.output, 'SCAN_CLEAN');
});

test('--all and --range report a git failure as SCAN_ERROR', async () => {
  const notARepo = mkdtempSync(join(tmpdir(), 't057b-not-a-repo-2-'));
  for (const result of [await scanAll({ env: envOf(), cwd: notARepo, repositoryRoot: notARepo }), await scanRange({ env: envOf(), cwd: notARepo, repositoryRoot: notARepo }, 'HEAD~1')]) {
    assert.equal(result.exitCode, 2);
    assert.equal(result.output, 'SCAN_ERROR git-failure');
  }
});
