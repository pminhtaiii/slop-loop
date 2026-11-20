/**
 * Shared T057 profile fixture: RFC 5737 / `.invalid` sentinels and a synthetic key only, never a real
 * host, port or credential. Each scanner test keeps its own sentinels for its case rows.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';

const KEY = 'sentinel-key-0123456789abcdef';
const MODEL = 'cmc/deepseek/deepseek-v4.1-flash';
const HREF = 'http://192.0.2.10:54321/v1/messages';
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
const IMAGE = { label: 'uc03-pytest:real-tier', imageId: `sha256:${sha256Text('image')}`, base: `python:3.12-alpine@sha256:${sha256Text('base')}`, platform: 'linux/amd64', user: '1000:1000' };

/** The sentinels every scanner test shares; a file keeps its own `PRIVATE` endpoint and key seed. */
export const SCAN_KEY = KEY;
export const SCAN_MODEL = MODEL;
export const SCAN_HREF = HREF;

export type ScanFixture = Readonly<{
  OUTSIDE: string;
  REPO: string;
  BASE: string;
  KEY: string;
  MODEL: string;
  HREF: string;
  DIGEST_KEY: string;
  PROVIDER: Readonly<Record<string, string | number | boolean>>;
  envOf: (patch?: Record<string, unknown>, env?: Record<string, string | undefined>) => RealTierEnvironment;
}>;

/**
 * One fixture per test file. `prefix` keeps each file's temp roots apart and `digestKeySeed` keeps
 * each file's own digest-key sentinel, so a leaked key is traced to the file that owns it.
 */
export function createScanFixture(prefix: string, digestKeySeed: string): ScanFixture {
  const OUTSIDE = mkdtempSync(join(tmpdir(), `${prefix}outside-`));
  const REPO = mkdtempSync(join(tmpdir(), `${prefix}repository-`));
  const BASE = mkdtempSync(join(tmpdir(), `${prefix}dir-`));
  /** A strong key derived here: the loader refuses weak ones, and the value is itself a needle. */
  const DIGEST_KEY = sha256Text(digestKeySeed);
  const PROVIDER = { endpoint: HREF, allowInsecureHttp: true, endpointDigestKey: DIGEST_KEY, model: MODEL, mode: 'nonstreaming', timeoutMs: 60000 } as const;
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
  /** Writes the profile outside the checkout and injects the environment; nothing reads the process env. */
  const envOf = (patch: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}): RealTierEnvironment => {
    const file = join(OUTSIDE, `profile-${profiles++}.json`);
    writeFileSync(file, JSON.stringify({ ...defaults(), ...patch }), 'utf8');
    return { UC03_REAL_TIER_PROFILE: file, ANTHROPIC_API_KEY: KEY, ...env };
  };
  return { OUTSIDE, REPO, BASE, KEY, MODEL, HREF, DIGEST_KEY, PROVIDER, envOf };
}
