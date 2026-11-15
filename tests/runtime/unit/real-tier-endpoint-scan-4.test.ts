/**
 * T057 CodeRabbit repairs: a host needle ignores letter case, a private endpoint needs the digest key
 * even behind the public default, index and history run at the worktree root, and the host-template
 * guard keeps the needles of the profile it serialized.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runRealTierScanCli } from '../../../src/cli/real-tier-scan.ts';
import { scanAll, scanDirectory, scanRange, scanStaged, type ScanGit, type ScanResult } from '../../../src/runtime/real-tier-endpoint-scan.ts';
import type { RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { createScanFixture } from './real-tier-scan-fixtures.ts';

// RFC 5737 / `.invalid` sentinels and a synthetic key only: no real host, port or credential.
const { REPO, BASE, KEY, HREF, DIGEST_KEY, PROVIDER, envOf } = createScanFixture('t057d-', 't057d-endpoint-digest-key');

let cases = 0;

function scanFile(name: string, content: string, env: RealTierEnvironment): ScanResult {
  const dir = join(BASE, `case-${cases++}`);
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), content, 'utf8');
  return scanDirectory(dir, { env, repositoryRoot: REPO });
}

function quiet(result: ScanResult, values: readonly string[]): void {
  for (const forbidden of values) assert.equal(result.output.includes(forbidden), false, 'output must not echo a needle');
  assert.doesNotMatch(result.output, /fatal|matched/iu);
}

const git = (cwd: string, args: readonly string[]): string => execFileSync('git', ['-c', 'user.name=t057d', '-c', 'user.email=t057d@example.invalid', ...args], { cwd, encoding: 'utf8' });

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 't057d-repo-'));
  git(dir, ['init', '-q']);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content, 'utf8');
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  return dir;
}

test('CASE-HOST: a differently-cased host is a leak in content and in a path', () => {
  // Node lower-cases a URL host, so the profile's spelling cannot be the only one a leak can use.
  const env = envOf({ provider: { ...PROVIDER, endpoint: 'https://model.invalid/v1/messages', allowInsecureHttp: false } });
  const banners = ['model.invalid', 'MODEL.INVALID', 'Model.Invalid', KEY, DIGEST_KEY];
  for (const content of ['served by MODEL.INVALID\n', 'served by Model.Invalid\n']) {
    const result = scanFile('result.json', content, env);
    assert.equal(result.exitCode, 1, content);
    assert.equal(result.output, 'result.json:1 ENDPOINT_LEAK\nSCAN_LEAK', content);
    quiet(result, banners);
  }

  const path = scanFile('evidence/MODEL.INVALID/result.json', '{"outcome":"pass"}\n', env);
  assert.equal(path.exitCode, 1, 'a path is data, whatever its letter case');
  assert.match(path.output, /^path-hmac:[a-f0-9]{12}:0 ENDPOINT_LEAK\nSCAN_LEAK$/u);
  quiet(path, banners);

  // The credential and the digest key stay case-sensitive: a different spelling is a different secret.
  const otherCase = scanFile('result.json', `${KEY.toUpperCase()}\n${DIGEST_KEY.toUpperCase()}\n`, env);
  assert.equal(otherCase.exitCode, 0);
  assert.equal(otherCase.output, 'SCAN_CLEAN');
});

test('PRIVATE-KEY: a private endpoint behind the public default still needs the digest key', () => {
  // Without the key the scanner would print an unkeyed `path-sha256:` for a guessable private host.
  const provider = { ...PROVIDER } as Record<string, unknown>;
  delete provider.endpoint;
  delete provider.endpointDigestKey;
  const env = envOf({ provider, privacy: { additionalPrivateEndpoints: ['http://192.0.2.11:8080/v1/messages'] } });
  const result = scanFile('evidence/192.0.2.11/result.json', '{"outcome":"pass"}\n', env);
  assert.equal(result.exitCode, 2);
  assert.equal(result.output, 'SCAN_ERROR endpoint-digest-key-missing');

  // With the key the same profile shape scans and keys the path.
  const keyed = envOf({ provider: { ...PROVIDER }, privacy: { additionalPrivateEndpoints: ['http://192.0.2.11:8080/v1/messages'] } });
  const keyedResult = scanFile('evidence/192.0.2.11/result.json', '{"outcome":"pass"}\n', keyed);
  assert.equal(keyedResult.exitCode, 1);
  assert.match(keyedResult.output, /^path-hmac:[a-f0-9]{12}:0 ENDPOINT_LEAK\nSCAN_LEAK$/u);
});

test('WORKTREE-ROOT: a scan from a subdirectory lists and reads at the repository root', async () => {
  // A clean root `a.txt` used to mask the leaking `sub/a.txt`: `ls-files` is sub-relative, so the
  // listing named `a.txt` while the blob read resolved that name at the root.
  const dir = repoWith({ 'a.txt': 'clean\n', 'sub/a.txt': 'clean\n' });
  const sub = join(dir, 'sub');

  writeFileSync(join(sub, 'a.txt'), `${HREF}\n`, 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'leak under sub']);
  const all = await scanAll({ env: envOf(), cwd: sub, repositoryRoot: dir });
  assert.equal(all.exitCode, 1);
  assert.equal(all.output, 'sub/a.txt:1 ENDPOINT_LEAK\nSCAN_LEAK');
  quiet(all, ['192.0.2.10', '54321']);

  writeFileSync(join(sub, 'a.txt'), `${KEY}\n`, 'utf8');
  git(dir, ['add', '-A']);
  const staged = await scanStaged({ env: envOf(), cwd: sub, repositoryRoot: dir });
  assert.equal(staged.exitCode, 1);
  assert.equal(staged.output, 'sub/a.txt:1 CREDENTIAL_LEAK\nSCAN_LEAK');
  quiet(staged, ['192.0.2.10', '54321']);

  git(dir, ['commit', '-qm', 'leak staged']);
  const range = await scanRange({ env: envOf(), cwd: sub, repositoryRoot: dir }, 'HEAD~1');
  assert.equal(range.exitCode, 1, 'history also resolves its paths at the root');
  assert.equal(range.output, 'sub/a.txt:1 CREDENTIAL_LEAK\nSCAN_LEAK');
  quiet(range, ['192.0.2.10', '54321']);
});

test('GUARD-SNAPSHOT: the template guard uses the profile it serialized, never a reload', async () => {
  // Profile A's model id spells A's private host. The reload-based guard would read profile B, written
  // during the git call, whose needles miss that host — and print it.
  const privateHost = 'model.invalid';
  const first = envOf({ provider: { ...PROVIDER, endpoint: `https://${privateHost}/v1/messages`, allowInsecureHttp: false, model: privateHost } });
  const second = envOf({ provider: { ...PROVIDER, endpoint: 'http://192.0.2.12:54321/v1/messages' } });
  const replacement = readFileSync(second.UC03_REAL_TIER_PROFILE as string, 'utf8');
  const gitDouble: ScanGit = args => {
    if (args[0] !== 'rev-parse') return Promise.resolve({ ok: false });
    writeFileSync(first.UC03_REAL_TIER_PROFILE as string, replacement, 'utf8');
    return Promise.resolve({ ok: true, stdout: 'a'.repeat(40) });
  };
  const result = await runRealTierScanCli(['--print-host-template'], { env: first, cwd: REPO, repositoryRoot: REPO, git: gitDouble });
  assert.equal(result.exitCode, 2);
  assert.equal(result.output, 'SCAN_ERROR template-needle');
  quiet(result, [privateHost, '192.0.2.10', '54321']);
});
