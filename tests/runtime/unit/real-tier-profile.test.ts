import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_REAL_TIER_ENDPOINT, loadRealTierProfile, type RealTierProfile } from '../../../src/runtime/real-tier-profile.ts';
import { sha256Text, type Validation } from '../../../src/uc01/contracts.ts';
// Reserved documentation addresses (RFC 5737) and synthetic values only: no real host, port or key.
const repoRoot = mkdtempSync(join(tmpdir(), 't047-repository-'));
const outsideRoot = mkdtempSync(join(tmpdir(), 't047-outside-'));
const KEY = 'synthetic-key-0123456789abcdef';
// A synthetic 64-character hex key with no literal: the secret scanner runs in CI.
const DIGEST_KEY = sha256Text('uc03 synthetic digest key');
const MODEL = 'po/deepseek-ai/deepseek-v4.1-flash-1017';
const HTTPS = 'https://192.0.2.10:8443/v1/messages';
const HTTP = 'http://192.0.2.10:8080/v1/messages';
const sha = (seed: string): string => sha256Text(seed);

const PROVIDER = { endpoint: HTTPS, model: MODEL, mode: 'nonstreaming', timeoutMs: 60000, endpointDigestKey: DIGEST_KEY } as const;
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
  stateRoot: join(outsideRoot, 'state'),
  provider: { ...PROVIDER },
  pricing: { ...PRICING },
  runLimits: { perRunInputTokens: 400000, perRunOutputTokens: 80000 },
  limits: { ...LIMITS },
  image: { ...IMAGE },
  // Fixtures and graders live in the checkout, so the catalog path is deliberately repository-local.
  catalog: { path: join(repoRoot, 'fixtures', 'uc03', 'catalog.json') },
  artifacts: { retainRoot: join(outsideRoot, 'artifacts'), retainRawStreams: false },
  approvalPolicy: { profileVersion: 'real-tier-2026-11-14' },
});

const profileOf = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({ ...defaults(), ...patch });
// Remote private endpoints behind the operator's loopback SSH tunnel: reserved documentation hosts only.
const TUNNEL = 'http://192.0.2.20:9443/v1/messages';
const TUNNEL_INVALID = 'http://model.invalid:8080/v1';
type Load = Validation<RealTierProfile>;

let writes = 0;
function load(profile: unknown, env: Record<string, string | undefined> = {}): Load {
  const file = join(outsideRoot, `profile-${writes++}.json`);
  writeFileSync(file, typeof profile === 'string' ? profile : JSON.stringify(profile), 'utf8');
  return loadRealTierProfile({ UC03_REAL_TIER_PROFILE: file, ANTHROPIC_API_KEY: KEY, ...env }, { repositoryRoot: repoRoot });
}

function loaded(result: Load): RealTierProfile {
  if (!result.ok) throw new Error(`unexpected refusal ${result.reasonCode} at ${result.path}`);
  return result.value;
}

function reasonOf(result: Load): string {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected a refusal');
  assert.match(result.reasonCode, /^[A-Za-z_-]+$/u, 'the reason is a bounded code, never file content');
  return result.reasonCode;
}

test('loads a valid external profile and pins the endpoint identity', () => {
  const value = loaded(load(profileOf()));

  assert.equal(value.schema, 'uc03-real-tier-profile/1');
  assert.equal(value.endpoint.href, HTTPS);
  assert.equal(value.endpoint.scheme, 'https');
  assert.equal(value.endpoint.endpointDigest, createHmac('sha256', DIGEST_KEY).update(HTTPS).digest('hex'));
  assert.notEqual(value.endpoint.endpointDigest, sha256Text(HTTPS));
  assert.equal(value.endpoint.insecureHttpAcknowledged, false);
  assert.equal(value.endpoint.model, MODEL);
  assert.equal(value.transport, 'https');
  assert.equal(value.credential, KEY);
  assert.deepEqual(value.runLimits, { perRunInputTokens: 400000, perRunOutputTokens: 80000 });
  assert.deepEqual(value.image, IMAGE);
  assert.equal(value.artifacts.retainRawStreams, false);
  assert.equal(value.catalog.path, join(repoRoot, 'fixtures', 'uc03', 'catalog.json'));
  assert.ok(Object.isFrozen(value));
});

test('keys the endpoint digest, deterministically for one key and href', () => {
  const first = loaded(load(profileOf())).endpoint.endpointDigest;
  const second = loaded(load(profileOf())).endpoint.endpointDigest;
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(first, second);
  const otherKey = loaded(load(profileOf({ provider: { ...PROVIDER, endpointDigestKey: sha256Text('uc03 synthetic digest key alternate') } }))).endpoint.endpointDigest;
  assert.notEqual(first, otherKey);
});

test('refuses an obviously weak digest key without echoing it', () => {
  // Pinned literals stay out: every fixture is generated, and none is derived from a real endpoint.
  const weak = [
    ['all-same', '0'.repeat(64)],
    ['low-variety', '012345678'.repeat(7) + '0'],
    ['repeating period 2', 'ab'.repeat(32)],
    ['repeating period 8', '01234567'.repeat(8)],
    ['one character over a quarter', '0'.repeat(17) + '123456789abc'.repeat(3) + '1'.repeat(11)],
  ] as const;
  for (const [name, endpointDigestKey] of weak) {
    const result = load(profileOf({ provider: { ...PROVIDER, endpointDigestKey } }));
    assert.equal(reasonOf(result), 'endpoint-digest-key-weak', name);
    assert.equal(JSON.stringify(result).includes(endpointDigestKey), false, name);
  }
});

test('refuses a non-default endpoint without a valid digest key, and accepts the public default without one', () => {
  const { endpoint, model: providerModel, mode, timeoutMs } = PROVIDER;
  const keyless = { endpoint, model: providerModel, mode, timeoutMs };
  for (const provider of [keyless, { ...PROVIDER, endpointDigestKey: 'AB'.repeat(32) }, { ...PROVIDER, endpointDigestKey: 'ab'.repeat(31) }]) {
    assert.equal(reasonOf(load(profileOf({ provider }))), 'endpoint-digest-key-missing');
  }

  const value = loaded(load(profileOf({ provider: { ...keyless, endpoint: undefined, model: undefined } }), { ANTHROPIC_MODEL: MODEL }));
  assert.equal(value.endpoint.href, DEFAULT_REAL_TIER_ENDPOINT);
  assert.equal(value.endpoint.endpointDigest, sha256Text(DEFAULT_REAL_TIER_ENDPOINT));
});

test('never serializes the digest key', () => {
  const sentinel = sha256Text('uc03 synthetic digest key sentinel');
  const value = loaded(load(profileOf({ provider: { ...PROVIDER, endpointDigestKey: sentinel } })));
  const json = JSON.stringify(value);
  assert.equal(json.includes(sentinel), false);
  assert.equal(JSON.stringify(Object.entries(value)).includes(sentinel), false);
  assert.equal(json.includes(KEY), false);
  // Like the credential, the key stays an in-memory, non-enumerable handle.
  assert.equal(Object.keys(value).includes('endpointDigestKey'), false);
  assert.equal(value.endpointDigestKey, sentinel);
  assert.equal(Object.keys(value.endpoint).includes('endpointDigestKey'), false);

  const refused = load(profileOf({ provider: { ...PROVIDER, endpointDigestKey: sentinel }, campaignId: 'x'.repeat(5000) }));
  assert.equal(JSON.stringify(refused).includes(sentinel), false);
});

test('serialization, digest input and enumerable keys carry only the digest and the scheme', () => {
  const value = loaded(load(profileOf()));
  const json = JSON.stringify(value);

  assert.equal(json.includes(KEY), false);
  assert.equal(json.includes('192.0.2.10'), false);
  assert.equal(json.includes('/v1/messages'), false);
  assert.equal(json.includes('8080'), false);
  assert.ok(json.includes(value.endpoint.endpointDigest));
  assert.ok(json.includes('"scheme":"https"'));
  assert.equal(Object.keys(value).includes('credential'), false);
  assert.ok('credential' in value);
  assert.deepEqual(Object.keys(value.endpoint).sort(), ['endpointDigest', 'insecureHttpAcknowledged', 'model', 'scheme']);

  const { profileDigest, ...serializable } = value;
  assert.match(profileDigest, /^[a-f0-9]{64}$/u);
  assert.equal(profileDigest, sha256Text(JSON.stringify(serializable)));
});

test('resolves the endpoint and model from the environment when the profile omits them', () => {
  const value = loaded(
    load(profileOf({ provider: { ...PROVIDER, endpoint: undefined, model: undefined, allowInsecureHttp: true } }), {
      ANTHROPIC_BASE_URL: 'http://192.0.2.10:8080/v1/',
      ANTHROPIC_MODEL: MODEL,
    }),
  );

  assert.equal(value.endpoint.href, HTTP);
  assert.equal(value.endpoint.scheme, 'http');
  assert.equal(value.endpoint.model, MODEL);
  assert.equal(value.transport, 'insecure-http-acknowledged');
});

test('falls back to the pinned default endpoint when neither source sets one', () => {
  const value = loaded(load(profileOf({ provider: { ...PROVIDER, endpoint: undefined, model: undefined } }), { ANTHROPIC_MODEL: MODEL }));

  assert.equal(value.endpoint.href, DEFAULT_REAL_TIER_ENDPOINT);
  assert.equal(value.endpoint.scheme, 'https');
});

test('refuses an endpoint set in both places with different values', () => {
  const result = load(profileOf({ provider: { ...PROVIDER, allowInsecureHttp: true } }), { ANTHROPIC_BASE_URL: 'http://192.0.2.11:8080/v1' });
  assert.equal(reasonOf(result), 'endpoint-ambiguous');
});

test('accepts an endpoint set in both places with the same value', () => {
  const value = loaded(load(profileOf({ provider: { ...PROVIDER, endpoint: HTTP, allowInsecureHttp: true } }), { ANTHROPIC_BASE_URL: 'http://192.0.2.10:8080/v1' }));
  assert.equal(value.endpoint.href, HTTP);
});

test('refuses a model set in both places with different values, and accepts the same one', () => {
  assert.equal(reasonOf(load(profileOf(), { ANTHROPIC_MODEL: 'another-model' })), 'model-ambiguous');
  assert.equal(loaded(load(profileOf(), { ANTHROPIC_MODEL: MODEL })).endpoint.model, MODEL);
});

test('refuses malformed endpoint URLs', () => {
  const invalid = [
    'https://operator:secret@192.0.2.10:8443/v1/messages',
    'https://192.0.2.10:8443/v1/messages?flag=1',
    'https://192.0.2.10:8443/v1/messages#fragment',
    '/v1/messages',
    'https://192.0.2.10:8443/v1',
    'ftp://192.0.2.10:8443/v1/messages',
  ];
  for (const endpoint of invalid) {
    assert.equal(reasonOf(load(profileOf({ provider: { ...PROVIDER, endpoint } }))), 'endpoint-invalid', endpoint);
  }
});

test('refuses plain http until the operator acknowledges it, then accepts and flags it', () => {
  assert.equal(reasonOf(load(profileOf({ provider: { ...PROVIDER, endpoint: HTTP } }))), 'insecure-endpoint-unacknowledged');

  const value = loaded(load(profileOf({ provider: { ...PROVIDER, endpoint: HTTP, allowInsecureHttp: true } })));
  assert.equal(value.endpoint.scheme, 'http');
  assert.equal(value.endpoint.insecureHttpAcknowledged, true);
  assert.equal(value.transport, 'insecure-http-acknowledged');
});

test('refuses a missing or blank credential', () => {
  assert.equal(reasonOf(load(profileOf(), { ANTHROPIC_API_KEY: undefined })), 'credential-missing');
  assert.equal(reasonOf(load(profileOf(), { ANTHROPIC_API_KEY: '   ' })), 'credential-missing');
});

test('refuses a missing profile reference and an unreadable or unparsable profile', () => {
  assert.equal(reasonOf(load(profileOf(), { UC03_REAL_TIER_PROFILE: undefined })), 'profile-path-missing');
  assert.equal(reasonOf(load(profileOf(), { UC03_REAL_TIER_PROFILE: join(outsideRoot, 'absent.json') })), 'profile-unreadable');
  assert.equal(reasonOf(load('{"schema":')), 'profile-unreadable');
});

test('refuses unknown keys at any depth without echoing the file', () => {
  assert.equal(reasonOf(load(profileOf({ extra: true }))), 'UNKNOWN_FIELD');
  assert.equal(reasonOf(load(profileOf({ provider: { ...PROVIDER, extra: true } }))), 'UNKNOWN_FIELD');

  const result = load(profileOf({ credential: KEY }));
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('refuses malformed numbers, unpinned images and retained raw streams', () => {
  const mutations: readonly (readonly [string, Record<string, unknown>])[] = [
    ['retained raw streams', { artifacts: { retainRoot: join(outsideRoot, 'artifacts'), retainRawStreams: true } }],
    ['unpinned image id', { image: { ...IMAGE, imageId: 'uc03-runtime:latest' } }],
    ['unpinned image base', { image: { ...IMAGE, base: 'python:3.12-alpine' } }],
    ['zero run limit', { runLimits: { perRunInputTokens: 0, perRunOutputTokens: 80000 } }],
    ['fractional run limit', { runLimits: { perRunInputTokens: 400000, perRunOutputTokens: 1.5 } }],
    ['fractional cpus', { limits: { ...LIMITS, cpus: 1.5 } }],
    ['unbounded timeout', { provider: { ...PROVIDER, timeoutMs: 1e300 } }],
    ['model outside the identifier rule', { provider: { ...PROVIDER, model: 'deep seek' } }],
  ];
  for (const [name, patch] of mutations) {
    const result = load(profileOf(patch));
    assert.equal(result.ok, false, name);
    assert.equal(reasonOf(result).includes(KEY), false, name);
  }
});

test('refuses any profile, state or artifact path inside the repository root', () => {
  const inside = join(repoRoot, 'profile.json');
  writeFileSync(inside, JSON.stringify(defaults()), 'utf8');
  assert.equal(reasonOf(loadRealTierProfile({ UC03_REAL_TIER_PROFILE: inside, ANTHROPIC_API_KEY: KEY }, { repositoryRoot: repoRoot })), 'profile-inside-repository');

  assert.equal(reasonOf(load(profileOf({ stateRoot: join(repoRoot, 'state') }))), 'state-root-inside-repository');
  assert.equal(reasonOf(load(profileOf({ artifacts: { retainRoot: join(repoRoot, 'artifacts'), retainRawStreams: false } }))), 'artifacts-inside-repository');
});

test('refuses a dot-dot-prefixed directory name inside the repository', () => {
  // `..private` is a name inside the checkout, not the parent path `..`.
  mkdirSync(join(repoRoot, '..private'), { recursive: true });
  assert.equal(reasonOf(load(profileOf({ stateRoot: join(repoRoot, '..private', 'state') }))), 'state-root-inside-repository');
  assert.equal(reasonOf(load(profileOf({ artifacts: { retainRoot: join(repoRoot, '..private'), retainRawStreams: false } }))), 'artifacts-inside-repository');
});

test('refuses any path that reaches the repository through a directory junction', t => {
  // A junction outside the checkout whose target is inside it stays lexically outside until realpath is followed.
  const target = join(repoRoot, 'junction-target');
  mkdirSync(target, { recursive: true });
  const container = mkdtempSync(join(tmpdir(), 't047-junction-'));
  const alias = join(container, 'alias');
  symlinkSync(target, alias, 'junction');
  writeFileSync(join(target, 'profile.json'), JSON.stringify(defaults()), 'utf8');
  t.after(() => {
    unlinkSync(alias); // Unlinks the junction itself; nothing is deleted through it.
    rmSync(container, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  const env = { UC03_REAL_TIER_PROFILE: join(alias, 'profile.json'), ANTHROPIC_API_KEY: KEY };
  assert.equal(reasonOf(loadRealTierProfile(env, { repositoryRoot: repoRoot })), 'profile-inside-repository');
  assert.equal(reasonOf(loadRealTierProfile({ ...env, UC03_REAL_TIER_PROFILE: join(alias, 'absent', 'profile.json') }, { repositoryRoot: repoRoot })), 'profile-inside-repository');
  assert.equal(reasonOf(load(profileOf({ stateRoot: alias }))), 'state-root-inside-repository');
  assert.equal(reasonOf(load(profileOf({ stateRoot: join(alias, 'state') }))), 'state-root-inside-repository');
  assert.equal(reasonOf(load(profileOf({ artifacts: { retainRoot: alias, retainRawStreams: false } }))), 'artifacts-inside-repository');
  assert.equal(reasonOf(load(profileOf({ artifacts: { retainRoot: join(alias, 'artifacts'), retainRawStreams: false } }))), 'artifacts-inside-repository');
});

test('a malformed profile gives a bounded reason with no file content or endpoint bytes echoed', () => {
  const result = load(profileOf({ campaignId: 'x'.repeat(5000) }));

  assert.equal(reasonOf(result), 'INVALID_TEXT');
  const text = JSON.stringify(result);
  assert.equal(text.includes('192.0.2.10'), false);
  assert.equal(text.includes(KEY), false);
  assert.equal(text.includes('x'.repeat(64)), false);
});

test('accepts tunnel private endpoints, keeping their bytes out of serialization, the digest and errors', () => {
  const second = 'https://tunnel.invalid:8443/v1/messages';
  const value = loaded(load(profileOf({ privacy: { additionalPrivateEndpoints: [TUNNEL, second, TUNNEL_INVALID] } })));

  assert.deepEqual(value.privacy.additionalPrivateEndpoints, [TUNNEL, second, TUNNEL_INVALID]);
  assert.ok(Object.isFrozen(value.privacy));
  assert.equal(Object.keys(value).includes('privacy'), false);
  const json = JSON.stringify(value);
  for (const needle of ['192.0.2.20', '9443', 'tunnel.invalid', '/v1/messages']) assert.equal(json.includes(needle), false, needle);
  assert.deepEqual(loaded(load(profileOf({ privacy: { additionalPrivateEndpoints: [] } }))).privacy.additionalPrivateEndpoints, []);

  const refused = load(profileOf({ privacy: { additionalPrivateEndpoints: [TUNNEL], campaignId: 'x'.repeat(5000) } }));
  const reason = reasonOf(refused);
  assert.equal(JSON.stringify(refused).includes('192.0.2.20'), false);
  assert.equal(reason.includes('192.0.2.20'), false);
});

test('accepts tunnel private endpoints behind a loopback endpoint', () => {
  const loopback = 'http://127.0.0.1:54321/v1/messages';
  const value = loaded(load(profileOf({ provider: { ...PROVIDER, endpoint: loopback, allowInsecureHttp: true }, privacy: { additionalPrivateEndpoints: [TUNNEL] } })));

  assert.equal(value.endpoint.href, loopback);
  assert.deepEqual(value.privacy.additionalPrivateEndpoints, [TUNNEL]);
});

test('refuses malformed tunnel private endpoints with a bounded, value-free reason', () => {
  const invalid: readonly unknown[] = [
    '',
    '   ',
    `http://192.0.2.20:9443/v1/messages#${'x'.repeat(64)}`,
    'http://user:secret@192.0.2.20:9443/v1/messages',
    'http://192.0.2.20:9443/v1/messages?token=abc',
    'ftp://192.0.2.20:9443/v1/messages',
    '/v1/messages',
    42,
    null,
    ['http://192.0.2.20:9443/v1/messages'],
  ];
  for (const entry of invalid) {
    const result = load(profileOf({ privacy: { additionalPrivateEndpoints: [entry] } }));
    assert.equal(reasonOf(result), 'private-endpoints-invalid', JSON.stringify(entry));
    assert.equal(JSON.stringify(result).includes('192.0.2.20'), false);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }

  for (const listed of ['not-an-array', { 0: TUNNEL }, undefined]) {
    assert.equal(reasonOf(load(profileOf({ privacy: { additionalPrivateEndpoints: listed } }))), 'private-endpoints-invalid');
  }
  const nine = Array.from({ length: 9 }, (_, index) => `http://192.0.2.${index + 1}:9443/v1/messages`);
  assert.equal(reasonOf(load(profileOf({ privacy: { additionalPrivateEndpoints: nine } }))), 'private-endpoints-invalid');
  assert.equal(reasonOf(load(profileOf({ privacy: { extra: [] } }))), 'UNKNOWN_FIELD');
  assert.equal(reasonOf(load(profileOf({ privacy: [TUNNEL] }))), 'INVALID_INPUT');
});
