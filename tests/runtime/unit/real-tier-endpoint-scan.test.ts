/** T057: the quiet endpoint scanner — needle forms, endpoint resolution, credential handling and path privacy. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scanDirectory, type ScanResult } from '../../../src/runtime/real-tier-endpoint-scan.ts';
import type { RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { createScanFixture } from './real-tier-scan-fixtures.ts';

// RFC 5737 / `.invalid` sentinels and a synthetic key only: no real host, port or credential.
const { REPO, BASE, KEY, HREF, DIGEST_KEY, PROVIDER, envOf } = createScanFixture('t057-', 't057-endpoint-digest-key');
const PRIVATE = 'http://192.0.2.11:54321/v1/messages';

let cases = 0;

/** Scans one file in its own directory, so a relative-path row sees exactly that file. */
function scanFile(name: string, content: string, env: RealTierEnvironment = envOf()): ScanResult {
  const dir = join(BASE, `case-${cases++}`);
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), content, 'utf8');
  return scanDirectory(dir, { env, repositoryRoot: REPO, cwd: REPO });
}

/** Every row proves the quiet half of the contract: no needle and no sentinel is ever echoed. */
function quiet(result: ScanResult): void {
  for (const forbidden of ['192.0.2.10', '192.0.2.11', '54321', KEY, DIGEST_KEY, 'model.invalid', '127.0.0.1']) {
    assert.equal(result.output.includes(forbidden), false, 'output must not echo a needle or sentinel');
  }
  assert.doesNotMatch(result.output, /matched|fatal|Error:/u, 'no matched line or child error text');
}

const leakKinds = (result: ScanResult): readonly string[] => result.output.split('\n').filter(line => / (?:ENDPOINT|CREDENTIAL)_LEAK$/u.test(line));

test('every derived needle form is a leak at exit 1 and stays quiet', () => {
  const forms: readonly (readonly [string, string])[] = [
    ['full-url', HREF],
    ['base-url', 'http://192.0.2.10:54321/v1'],
    ['host-port', '192.0.2.10:54321'],
    ['host-only', '192.0.2.10'],
    ['scheme-less-host-port-path', '192.0.2.10:54321/v1/messages'],
    ['encoded-full-url', encodeURIComponent(HREF)],
    ['encoded-host-port', '192.0.2.10%3A54321'],
  ];
  for (const [form, content] of forms) {
    const result = scanFile('result.json', `observed ${content} now\n`);
    assert.equal(result.exitCode, 1, form);
    assert.equal(leakKinds(result).length, 1, form);
    assert.match(result.output, /^result\.json:1 ENDPOINT_LEAK\nSCAN_LEAK$/u, form);
    quiet(result);
  }
});

test('host-boundary and loopback rules keep the host-only needle narrow', () => {
  const neighbour = scanFile('result.json', 'host 192.0.2.70 served the run\n', envOf({ provider: { ...PROVIDER, endpoint: 'http://192.0.2.7:54321/v1/messages' } }));
  assert.equal(neighbour.exitCode, 0, '192.0.2.7 does not match 192.0.2.70');
  assert.equal(neighbour.output, 'SCAN_CLEAN');

  // A loopback endpoint hides the remote host, so the profile lists it as a private endpoint.
  const loopback = envOf({ provider: { ...PROVIDER, endpoint: 'http://127.0.0.1:54321/v1/messages' }, privacy: { additionalPrivateEndpoints: [PRIVATE] } });
  const bare = scanFile('result.json', 'tunnel on 127.0.0.1\n', loopback);
  assert.equal(bare.exitCode, 0, 'a loopback host yields no host-only needle');
  const ported = scanFile('result.json', 'tunnel on 127.0.0.1:54321\n', loopback);
  assert.equal(ported.exitCode, 1);
  quiet(ported);
});

test('a loopback endpoint without a listed private endpoint is a scan error', () => {
  const env = envOf({ provider: { ...PROVIDER, endpoint: 'http://127.0.0.1:54321/v1/messages' } });
  const result = scanFile('result.json', 'clean\n', env);
  assert.equal(result.exitCode, 2);
  assert.equal(result.output, 'SCAN_ERROR tunnel-endpoint-missing');
});

test('each additional private endpoint contributes the same needles as the endpoint', () => {
  const env = envOf({ provider: { ...PROVIDER, endpoint: 'http://127.0.0.1:54321/v1/messages' }, privacy: { additionalPrivateEndpoints: ['http://198.51.100.20:8080/v1/messages'] } });
  const forms = [
    'http://198.51.100.20:8080/v1/messages',
    'http://198.51.100.20:8080/v1',
    '198.51.100.20:8080',
    '198.51.100.20',
    '198.51.100.20:8080/v1/messages',
    encodeURIComponent('198.51.100.20:8080'),
  ];
  for (const form of forms) {
    const result = scanFile('result.json', `${form}\n`, env);
    assert.equal(result.exitCode, 1, form);
    assert.equal(result.output, 'result.json:1 ENDPOINT_LEAK\nSCAN_LEAK', form);
    quiet(result);
  }
  const neighbour = scanFile('result.json', 'host 198.51.100.200 served\n', env);
  assert.equal(neighbour.exitCode, 0, 'the host boundary still holds for a private endpoint');
});

test('the digest key is a needle in content and paths, printed only as DIGEST_KEY_LEAK', () => {
  const content = scanFile('result.json', `{"provider":{"endpointDigestKey":"${DIGEST_KEY}"}}\n`);
  assert.equal(content.exitCode, 1);
  assert.match(content.output, /^result\.json:1 DIGEST_KEY_LEAK\nSCAN_LEAK$/u);
  quiet(content);

  const path = scanFile(`evidence/${DIGEST_KEY}/result.json`, '{"outcome":"pass"}\n');
  assert.equal(path.exitCode, 1);
  assert.match(path.output, /^path-hmac:[a-f0-9]{12}:0 DIGEST_KEY_LEAK\nSCAN_LEAK$/u);
  quiet(path);
});

test('the default public endpoint yields no needles', () => {
  const provider = { ...PROVIDER } as Record<string, unknown>;
  delete provider.endpoint;
  delete provider.endpointDigestKey;
  const env = envOf({ provider });
  const result = scanFile('result.json', 'endpoint https://api.deepseek.com/anthropic/v1/messages\n', env);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'SCAN_CLEAN');
});

test('the endpoint resolves from the profile, the environment, or both when equal', () => {
  const profileOnly = scanFile('result.json', 'host 192.0.2.10 seen\n');
  assert.equal(profileOnly.exitCode, 1);

  const provider = { ...PROVIDER } as Record<string, unknown>;
  delete provider.endpoint;
  const environmentOnly = scanFile('result.json', 'host model.invalid seen\n', envOf({ provider }, { ANTHROPIC_BASE_URL: 'http://model.invalid:54321/v1' }));
  assert.equal(environmentOnly.exitCode, 1);

  const bothEqual = scanFile('result.json', 'host 192.0.2.10 seen\n', envOf({}, { ANTHROPIC_BASE_URL: 'http://192.0.2.10:54321/v1' }));
  assert.equal(bothEqual.exitCode, 1);
  quiet(bothEqual);
});

test('the credential is a needle printed only as CREDENTIAL_LEAK', () => {
  const result = scanFile('result.json', `{"ANTHROPIC_API_KEY":"${KEY}"}\n`);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /^result\.json:1 CREDENTIAL_LEAK\nSCAN_LEAK$/u);
  quiet(result);
});

test('an unset credential needle is reported, never guessed', () => {
  const env = envOf({}, { ANTHROPIC_API_KEY: undefined });
  const result = scanFile('result.json', '{"note":"clean"}\n', env);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'SCAN_CLEAN credential-unchecked');
});

test('paths are data: a needle-bearing path leaks even with clean content', () => {
  const hostPath = scanFile('evidence/192.0.2.10/result.json', '{"outcome":"pass"}\n');
  assert.equal(hostPath.exitCode, 1);
  assert.match(hostPath.output, /^path-hmac:[a-f0-9]{12}:0 ENDPOINT_LEAK\nSCAN_LEAK$/u);
  quiet(hostPath);

  const credentialPath = scanFile(`${KEY}.txt`, '{"outcome":"pass"}\n');
  assert.equal(credentialPath.exitCode, 1);
  assert.match(credentialPath.output, /^path-hmac:[a-f0-9]{12}:0 CREDENTIAL_LEAK\nSCAN_LEAK$/u);
  quiet(credentialPath);

  const encodedPath = scanFile('evidence/192.0.2.10%3A54321/result.json', '{"outcome":"pass"}\n');
  assert.equal(encodedPath.exitCode, 1);
});

test('with the default public endpoint and no digest key a path hit is path-sha256', () => {
  const provider = { ...PROVIDER } as Record<string, unknown>;
  delete provider.endpoint;
  delete provider.endpointDigestKey;
  const result = scanFile(`evidence/${KEY}/result.json`, '{"outcome":"pass"}\n', envOf({ provider }));
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /^path-sha256:[a-f0-9]{12}:0 CREDENTIAL_LEAK\nSCAN_LEAK$/u);
  quiet(result);
});

test('the path hash is keyed: an operator matches it locally with the digest key', () => {
  const path = 'evidence/192.0.2.10/result.json';
  const expected = createHmac('sha256', DIGEST_KEY).update(path, 'utf8').digest('hex').slice(0, 12);
  const result = scanFile(path, 'clean\n');
  assert.equal(result.exitCode, 1);
  assert.equal(result.output, `path-hmac:${expected}:0 ENDPOINT_LEAK\nSCAN_LEAK`);
});

test('a leak under a clean path prints the plain relative path; a non-printable path is hashed', () => {
  const plain = scanFile('result.json', `${HREF}\n`);
  assert.equal(plain.exitCode, 1);
  assert.match(plain.output, /^result\.json:1 ENDPOINT_LEAK\nSCAN_LEAK$/u);

  const nonPrintable = scanFile('café.json', `${HREF}\n`);
  assert.equal(nonPrintable.exitCode, 1);
  assert.match(nonPrintable.output, /^path-hmac:[a-f0-9]{12}:1 ENDPOINT_LEAK\nSCAN_LEAK$/u);
  quiet(nonPrintable);
});

test('a leak under a needle-bearing path hashes the location and keeps the line', () => {
  const result = scanFile('evidence/192.0.2.10/result.json', 'clean\nproviderPort = 54321\n');
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /^path-hmac:[a-f0-9]{12}:0 ENDPOINT_LEAK\npath-hmac:[a-f0-9]{12}:2 ENDPOINT_LEAK\nSCAN_LEAK$/u);
  quiet(result);
});
