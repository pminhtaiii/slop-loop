/**
 * T057 review repairs (wave 2, P1-2/P1-3/P1-4/P2-5): merge-created blobs in `--range`, encoded IPv6
 * endpoint forms, the quiet host-template guard and empty evidence directories.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRealTierScanCli } from '../../../src/cli/real-tier-scan.ts';
import { scanDirectory, scanRange, type ScanResult } from '../../../src/runtime/real-tier-endpoint-scan.ts';
import type { RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';

// RFC 3849 / RFC 5737 sentinels and a synthetic key only: no real host, port or credential.
const OUTSIDE = mkdtempSync(join(tmpdir(), 't057c-outside-'));
const REPO = mkdtempSync(join(tmpdir(), 't057c-repository-'));
const BASE = mkdtempSync(join(tmpdir(), 't057c-dir-'));
const KEY = 'sentinel-key-0123456789abcdef';
const MODEL = 'po/deepseek-ai/deepseek-v4.1-flash-1017';
const HREF = 'http://192.0.2.10:54321/v1/messages';
const sha = (seed: string): string => sha256Text(seed);
const DIGEST_KEY = sha('t057c-endpoint-digest-key');

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

function quiet(result: ScanResult, values: readonly string[]): void {
  for (const forbidden of values) assert.equal(result.output.includes(forbidden), false, 'output must not echo a needle');
  assert.doesNotMatch(result.output, /fatal|matched/iu);
}

const git = (cwd: string, args: readonly string[]): string => execFileSync('git', ['-c', 'user.name=t057c', '-c', 'user.email=t057c@example.invalid', ...args], { cwd, encoding: 'utf8' });

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 't057c-repo-'));
  git(dir, ['init', '-q']);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(dir, name), content, 'utf8');
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  return dir;
}

test('IPV6-ENCODED: the encoded bracketed host and host:port are endpoint needles', () => {
  const endpoint = 'http://[2001:db8::7]:54321/v1/messages';
  const env = envOf({ provider: { ...PROVIDER, endpoint } });
  const rows: readonly (readonly [string, string])[] = [
    ['encoded-host-port', encodeURIComponent('[2001:db8::7]:54321')],
    ['encoded-host', encodeURIComponent('[2001:db8::7]')],
    ['encoded-url', encodeURIComponent(endpoint)],
    ['raw-host-port', '[2001:db8::7]:54321'],
    ['raw-host', 'served by [2001:db8::7] now'],
  ];
  for (const [form, content] of rows) {
    const result = scanContent(`${content}\n`, env);
    assert.equal(result.exitCode, 1, form);
    assert.equal(result.output, 'result.json:1 ENDPOINT_LEAK\nSCAN_LEAK', form);
    quiet(result, ['2001:db8::7', '54321', '2001%3Adb8']);
  }
});

test('IPV6-ENCODED: the encoded-host boundary still holds and IPv4/DNS rows keep passing', () => {
  const endpoint = 'http://[2001:db8::7]:54321/v1/messages';
  const env = envOf({ provider: { ...PROVIDER, endpoint } });
  const neighbour = scanContent(`${encodeURIComponent('[2001:db8::7]')}0\n`, env);
  assert.equal(neighbour.exitCode, 0, 'the encoded host keeps the host boundary');

  const ipv4 = scanContent('192.0.2.100\n', envOf());
  assert.equal(ipv4.exitCode, 0, '192.0.2.10 does not match 192.0.2.100');
  const dns = scanContent(`${encodeURIComponent('model.invalid:54321')}\n`, envOf({ provider: { ...PROVIDER, endpoint: 'http://model.invalid:54321/v1/messages' } }));
  assert.equal(dns.exitCode, 1);
});

test('MERGE: an endpoint introduced by a merge resolution and removed later stays blocked', async () => {
  const dir = repoWith({ 'a.txt': 'clean\n' });
  git(dir, ['checkout', '-qb', 'side']);
  writeFileSync(join(dir, 'side.txt'), 'side\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'side']);
  git(dir, ['checkout', '-q', '-']);
  git(dir, ['merge', '--no-ff', '--no-commit', 'side']);
  writeFileSync(join(dir, 'a.txt'), `${HREF}\n`, 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'merge']);
  writeFileSync(join(dir, 'a.txt'), 'clean\n', 'utf8');
  git(dir, ['commit', '-qam', 'remove']);

  const history = await scanRange({ env: envOf(), cwd: dir, repositoryRoot: dir }, 'HEAD~2');
  assert.equal(history.exitCode, 1);
  assert.equal(history.output, 'a.txt:1 ENDPOINT_LEAK\nSCAN_LEAK', 'each merge path is scanned once');
  quiet(history, ['192.0.2.10', '54321']);
});

test('TEMPLATE: the host template refuses to echo an endpoint, credential or digest key', async () => {
  const dir = repoWith({ 'a.txt': 'clean\n' });
  const rows: readonly (readonly [string, string])[] = [
    ['endpoint-model', HREF],
    ['credential-model', KEY],
    ['digest-key-model', DIGEST_KEY],
  ];
  for (const [row, model] of rows) {
    const env = envOf({ provider: { ...PROVIDER, model } });
    const result = await runRealTierScanCli(['--print-host-template'], { env, cwd: dir, repositoryRoot: dir });
    assert.equal(result.exitCode, 2, row);
    assert.equal(result.output, 'SCAN_ERROR template-needle', row);
    quiet(result, [model, '192.0.2.10', '54321']);
  }

  const clean = await runRealTierScanCli(['--print-host-template'], { env: envOf(), cwd: dir, repositoryRoot: dir });
  assert.equal(clean.exitCode, 0, 'a clean model still prints the template');
  assert.equal(clean.output.includes(MODEL), true);
});

test('EMPTY-DIR: a directory entry name is scanned even when the directory is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 't057c-empty-'));
  mkdirSync(join(dir, '192.0.2.10'));
  const result = scanDirectory(dir, { env: envOf(), repositoryRoot: REPO });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /^path-hmac:[a-f0-9]{12}:0 ENDPOINT_LEAK\nSCAN_LEAK$/u);
  quiet(result, ['192.0.2.10', '54321']);

  const clean = mkdtempSync(join(tmpdir(), 't057c-empty-clean-'));
  mkdirSync(join(clean, 'evidence', 'run-1'), { recursive: true });
  const cleanResult = scanDirectory(clean, { env: envOf(), repositoryRoot: REPO });
  assert.equal(cleanResult.exitCode, 0);
  assert.equal(cleanResult.output, 'SCAN_CLEAN');

  // A nested empty directory is still spelled by no file path, so it is checked exactly once.
  const nested = mkdtempSync(join(tmpdir(), 't057c-empty-nested-'));
  mkdirSync(join(nested, 'evidence', '192.0.2.10'), { recursive: true });
  writeFileSync(join(nested, 'evidence', 'result.json'), '{"outcome":"pass"}\n', 'utf8');
  const nestedResult = scanDirectory(nested, { env: envOf(), repositoryRoot: REPO });
  assert.equal(nestedResult.exitCode, 1);
  assert.match(nestedResult.output, /^path-hmac:[a-f0-9]{12}:0 ENDPOINT_LEAK\nSCAN_LEAK$/u);
});
