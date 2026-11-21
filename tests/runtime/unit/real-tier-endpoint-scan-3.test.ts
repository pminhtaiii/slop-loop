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
import { scanDirectory, scanRange, scanStaged, type ScanResult } from '../../../src/runtime/real-tier-endpoint-scan.ts';
import type { RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { createScanFixture } from './real-tier-scan-fixtures.ts';

// RFC 3849 / RFC 5737 sentinels and a synthetic key only: no real host, port or credential.
const { REPO, BASE, KEY, MODEL, HREF, DIGEST_KEY, PROVIDER, envOf } = createScanFixture('t057c-', 't057c-endpoint-digest-key');

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
  const rows = [
    ['endpoint-url-model', HREF, 'model-invalid'],
    ['endpoint-model', HREF.replace(/^https?:\/\//u, ''), 'template-needle'],
    ['credential-model', KEY, 'template-needle'],
    ['digest-key-model', DIGEST_KEY, 'template-needle'],
  ] as const;
  for (const [row, model, reason] of rows) {
    const env = envOf({ provider: { ...PROVIDER, model } });
    const result = await runRealTierScanCli(['--print-host-template'], { env, cwd: dir, repositoryRoot: dir });
    assert.equal(result.exitCode, 2, row);
    assert.equal(result.output, `SCAN_ERROR ${reason}`, row);
    quiet(result, [model, '192.0.2.10', '54321']);
  }

  const clean = await runRealTierScanCli(['--print-host-template'], { env: envOf(), cwd: dir, repositoryRoot: dir });
  assert.equal(clean.exitCode, 0, 'a clean model still prints the template');
  assert.equal(clean.output.includes(MODEL), true);
});

/** The sentinel host `192.0.2.10`, fully percent-encoded: every character has a `%XX` spelling. */
const ENCODED_HOST = '%31%39%32%2E%30%2E%32%2E%31%30';

test('ENCODED-ANCESTOR: an encoded ancestor stays a leak when a descendant has a malformed percent', () => {
  // The reproducer: no leaf directory exists, so the ancestor is only spelled by the child's path,
  // and decoding that whole path fails on `bad%.txt`.
  const dir = mkdtempSync(join(tmpdir(), 't057c-encoded-ancestor-'));
  mkdirSync(join(dir, ENCODED_HOST), { recursive: true });
  writeFileSync(join(dir, ENCODED_HOST, 'bad%.txt'), 'clean\n', 'utf8');
  const result = scanDirectory(dir, { env: envOf(), repositoryRoot: REPO });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /^path-hmac:[a-f0-9]{12}:0 ENDPOINT_LEAK\nSCAN_LEAK$/u);
  quiet(result, [ENCODED_HOST, '192.0.2.10', '54321']);
});

test('SEGMENT-DECODE: a valid encoded segment next to a malformed one is a leak', () => {
  // The encoded host is the file name and the malformed segment is its parent, so only a
  // per-segment decode finds it: the whole path throws.
  const dir = mkdtempSync(join(tmpdir(), 't057c-segment-decode-'));
  mkdirSync(join(dir, 'bad%'), { recursive: true });
  writeFileSync(join(dir, 'bad%', ENCODED_HOST), 'clean\n', 'utf8');
  const result = scanDirectory(dir, { env: envOf(), repositoryRoot: REPO });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /^path-hmac:[a-f0-9]{12}:0 ENDPOINT_LEAK\nSCAN_LEAK$/u);
  quiet(result, [ENCODED_HOST, '192.0.2.10', '54321']);
});

test('NO-DUPLICATE: a nested leak name is reported once', () => {
  const raw = mkdtempSync(join(tmpdir(), 't057c-nested-raw-'));
  mkdirSync(join(raw, 'evidence', '192.0.2.10', 'run-1'), { recursive: true });
  writeFileSync(join(raw, 'evidence', '192.0.2.10', 'run-1', 'result.json'), '{"outcome":"pass"}\n', 'utf8');
  const rawResult = scanDirectory(raw, { env: envOf(), repositoryRoot: REPO });
  assert.equal(rawResult.exitCode, 1);
  assert.match(rawResult.output, /^path-hmac:[a-f0-9]{12}:0 ENDPOINT_LEAK\nSCAN_LEAK$/u);
  quiet(rawResult, ['192.0.2.10', '54321']);

  const encoded = mkdtempSync(join(tmpdir(), 't057c-nested-encoded-'));
  mkdirSync(join(encoded, 'evidence', ENCODED_HOST, 'run-1'), { recursive: true });
  writeFileSync(join(encoded, 'evidence', ENCODED_HOST, 'run-1', 'result.json'), '{"outcome":"pass"}\n', 'utf8');
  const encodedResult = scanDirectory(encoded, { env: envOf(), repositoryRoot: REPO });
  assert.equal(encodedResult.exitCode, 1);
  assert.match(encodedResult.output, /^path-hmac:[a-f0-9]{12}:0 ENDPOINT_LEAK\nSCAN_LEAK$/u);
  quiet(encodedResult, [ENCODED_HOST, '192.0.2.10', '54321']);
});

test('SEGMENT-DECODE: the staged mode decodes each path segment on its own', async () => {
  const dir = repoWith({ 'a.txt': 'clean\n' });
  mkdirSync(join(dir, 'evidence', ENCODED_HOST), { recursive: true });
  writeFileSync(join(dir, 'evidence', ENCODED_HOST, 'bad%.txt'), 'clean\n', 'utf8');
  git(dir, ['add', '-A']);
  const result = await scanStaged({ env: envOf(), cwd: dir, repositoryRoot: dir });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /^path-hmac:[a-f0-9]{12}:0 ENDPOINT_LEAK\nSCAN_LEAK$/u);
  quiet(result, [ENCODED_HOST, '192.0.2.10', '54321']);
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
