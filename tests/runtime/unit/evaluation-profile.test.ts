import test, { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  admitEvaluationProfile,
  bindEvaluationSource,
  deriveExposureCeiling,
  isAdmittedEvaluationProfile,
  type CatalogEntry,
  type EvaluationLimits,
  type SourceHost,
} from '../../../src/runtime/evaluation-profile.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';

const digest = (seed: string): string => sha256Text(seed);
const limits: EvaluationLimits = {
  totalModelCalls: 24,
  inputTokensPerRequest: 32768,
  outputTokensPerRequest: 8192,
  providerTimeoutMs: 60000,
  activeExecutionMs: 900000,
  repairs: 2,
  reviewerIterations: 2,
  materialReplans: 3,
  commandTimeoutMs: 30000,
  outputBytes: 1048576,
  memoryBytes: 2147483648,
  cpus: 2,
  processes: 64,
};
const pricing = { pricingId: 'deepseek-pin-v1', inputRate: 270, outputRate: 1100, cacheRate: 27, overheadRate: 10, denominator: 1 };
const fixtureDir = mkdtempSync(join(tmpdir(), 'runtime-evaluation-profile-'));
for (const caseId of ['case-001', 'case-002']) {
  writeFileSync(join(fixtureDir, `${caseId}.json`), '{}', 'utf8');
  writeFileSync(join(fixtureDir, `${caseId}.grader.json`), '{}', 'utf8');
}
const entry = (caseId: string): CatalogEntry => ({
  catalogEntryId: `entry-${caseId}`,
  caseId,
  version: '1.0.0',
  caseDigest: digest(`case-${caseId}`),
  publicTaskDigest: digest(`task-${caseId}`),
  initialRepositoryDigest: digest(`repo-${caseId}`),
  fixturePath: join(fixtureDir, `${caseId}.json`),
  fixtureDigest: digest(`fixture-${caseId}`),
  grader: { version: '1.0.0', digest: digest(`grader-${caseId}`), path: join(fixtureDir, `${caseId}.grader.json`) },
});
const makeCatalog = (caseIds: readonly string[]): readonly CatalogEntry[] => caseIds.map(entry);
const rawProfile = (catalog: readonly CatalogEntry[], overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  endpoint: 'https://api.deepseek.com/v1/messages',
  model: 'deepseek-v4.1',
  mode: 'nonstreaming',
  credentialRef: 'host-deepseek-key',
  codeDigest: digest('code'),
  configDigest: digest('config'),
  imageDigest: `sha256:${digest('image')}`,
  platform: 'linux/amd64',
  adapterVersions: ['uc03-adapter@1', 'grader-adapter@1'],
  pricing,
  limits,
  catalog,
  ...overrides,
});
const baseProfile = Object.freeze(makeCatalog(['case-001', 'case-002']));
const admittedProfile = (): ReturnType<typeof admitEvaluationProfile> => admitEvaluationProfile(rawProfile(baseProfile));
const hostFor = (profile: Extract<ReturnType<typeof admitEvaluationProfile>, { ok: true }>['value'], catalog = baseProfile): SourceHost => ({
  profile,
  catalog,
  repositoryIds: ['repo-configured'],
  checkSetIds: ['checks-configured'],
});
const bugSource = (sourceOverrides: Record<string, unknown> = {}, inputOverrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'bug',
  repositoryId: 'repo-configured',
  checkSetId: 'checks-configured',
  ...sourceOverrides,
  bugInput: {
    goal: 'Fix the failing endpoint',
    observedBehavior: 'Server returns 500',
    expectedBehavior: 'Server returns 200',
    reproduction: 'Run the integration test',
    acceptanceCriteria: ['Endpoint returns 200'],
    ...inputOverrides,
  },
});

after(() => rmSync(fixtureDir, { recursive: true, force: true }));

describe('evaluation profile admission', () => {
  it('admits and freezes an explicit finite profile', () => {
    const result = admittedProfile();
    assert.ok(result.ok);
    assert.equal(result.value.spendPolicy, 'derived-exposure');
    assert.equal(Object.isFrozen(result.value), true);
    assert.equal(Object.isFrozen(result.value.limits), true);
    assert.equal(isAdmittedEvaluationProfile(result.value), true);
    assert.equal(isAdmittedEvaluationProfile({ ...result.value }), false);
  });

  it('denies absent and invalid limits instead of defaulting', () => {
    const { limits: _omitted, ...withoutLimits } = rawProfile(baseProfile);
    void _omitted;
    const absent = admitEvaluationProfile(withoutLimits);
    assert.equal(absent.ok, false);

    const missingField = admitEvaluationProfile(rawProfile(baseProfile, { limits: { ...limits, cpus: undefined } }));
    assert.equal(missingField.ok, false);
    assert.equal(missingField.ok ? '' : missingField.reasonCode, 'MISSING_LIMIT');

    for (const invalid of [0, 1.5, '24', -1]) {
      const result = admitEvaluationProfile(rawProfile(baseProfile, { limits: { ...limits, totalModelCalls: invalid } }));
      assert.equal(result.ok, false);
      assert.equal(result.ok ? '' : result.reasonCode, 'INVALID_LIMIT');
    }
    const timeout = admitEvaluationProfile(rawProfile(baseProfile, { limits: { ...limits, commandTimeoutMs: 900001 } }));
    assert.equal(timeout.ok ? '' : timeout.reasonCode, 'INVALID_LIMIT');
  });

  it('denies missing pricing rather than guessing a rate', () => {
    const { cacheRate: _cache, ...withoutCache } = pricing;
    void _cache;
    const result = admitEvaluationProfile(rawProfile(baseProfile, { pricing: withoutCache }));
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.reasonCode, 'MISSING_PRICING');
  });

  it('denies missing fixtures and graders, not just their digests', () => {
    const missingFixture = admitEvaluationProfile(rawProfile([{ ...entry('case-001'), fixturePath: join(fixtureDir, 'absent.json') }]));
    assert.equal(missingFixture.ok ? '' : missingFixture.reasonCode, 'MISSING_FIXTURE');
    const missingGrader = admitEvaluationProfile(rawProfile([{ ...entry('case-001'), grader: { ...entry('case-001').grader, path: join(fixtureDir, 'absent.grader.json') } }]));
    assert.equal(missingGrader.ok ? '' : missingGrader.reasonCode, 'MISSING_GRADER');
  });

  it('rejects embedded secret material and keeps credential references host-only', () => {
    const embedded = admitEvaluationProfile(rawProfile(baseProfile, { model: 'sk-ant-abcdefghijklmnopqrstuvwx' }));
    assert.equal(embedded.ok ? '' : embedded.reasonCode, 'SECRET_MATERIAL');
    const valueSecret = admitEvaluationProfile(rawProfile(baseProfile, { credentialRef: 'sk-ant-abcdefghijklmnopqrstuvwx' }));
    assert.equal(valueSecret.ok ? '' : valueSecret.reasonCode, 'SECRET_MATERIAL');
    const invalidRef = admitEvaluationProfile(rawProfile(baseProfile, { credentialRef: 'Host Secret Key' }));
    assert.equal(invalidRef.ok ? '' : invalidRef.reasonCode, 'INVALID_CREDENTIAL_REF');

    const first = admitEvaluationProfile(rawProfile(baseProfile, { credentialRef: 'host-key-one' }));
    const second = admitEvaluationProfile(rawProfile(baseProfile, { credentialRef: 'host-key-two' }));
    assert.ok(first.ok && second.ok);
    assert.equal(first.value.profileDigest, second.value.profileDigest);
    assert.equal(JSON.stringify(first.value).includes('host-key-one'), true);
  });

  it('pins the trusted HTTPS endpoint only', () => {
    for (const endpoint of ['http://api.deepseek.com/v1/messages', 'https://evil.example/v1/messages', 'https://api.deepseek.com/v1/messages?x=1']) {
      const result = admitEvaluationProfile(rawProfile(baseProfile, { endpoint }));
      assert.equal(result.ok ? '' : result.reasonCode, 'INVALID_ENDPOINT');
    }
  });

  it('derives a stable catalog digest across caller order and rejects a swapped catalog', () => {
    const forward = admitEvaluationProfile(rawProfile(makeCatalog(['case-001', 'case-002'])));
    const reversed = admitEvaluationProfile(rawProfile(makeCatalog(['case-002', 'case-001'])));
    assert.ok(forward.ok && reversed.ok);
    assert.equal(forward.value.catalogDigest, reversed.value.catalogDigest);

    const host = hostFor(forward.value, makeCatalog(['case-002']));
    const result = bindEvaluationSource({ kind: 'catalog', caseIds: ['case-002'] }, host);
    assert.equal(result.ok ? '' : result.reasonCode, 'CATALOG_MISMATCH');
  });
});

describe('exposure derivation', () => {
  it('rounds upward per call and covers every permitted coder/reviewer call', () => {
    const profile = admittedProfile();
    assert.ok(profile.ok);
    const result = deriveExposureCeiling(profile.value);
    assert.ok(result.ok);
    assert.equal(result.value.calls, 24);
    assert.equal(result.value.numeratorPerCall, 32768 * 270 + 8192 * 1100 + 32768 * 27 + 10);
    assert.equal(result.value.ceilingMicroUsd, result.value.perCallMicroUsd * 24);
    assert.ok(Number.isSafeInteger(result.value.ceilingMicroUsd));
  });

  it('rounds a fractional micro-USD upward', () => {
    const result = admitEvaluationProfile(
      rawProfile([entry('case-001')], {
        pricing: { pricingId: 'fractional', inputRate: 1, outputRate: 1, cacheRate: 1, overheadRate: 1, denominator: 3 },
        limits: { ...limits, totalModelCalls: 1, inputTokensPerRequest: 1, outputTokensPerRequest: 1 },
      }),
    );
    assert.ok(result.ok);
    const derivation = deriveExposureCeiling(result.value);
    assert.ok(derivation.ok);
    assert.equal(derivation.value.numeratorPerCall, 4);
    assert.equal(derivation.value.perCallMicroUsd, 2);
    assert.equal(derivation.value.ceilingMicroUsd, 2);
  });

  it('denies overflow and unadmitted profiles instead of returning a sentinel', () => {
    const huge = admitEvaluationProfile(rawProfile([entry('case-001')], { pricing: { ...pricing, inputRate: Number.MAX_SAFE_INTEGER } }));
    assert.ok(huge.ok);
    const overflow = deriveExposureCeiling(huge.value);
    assert.equal(overflow.ok ? '' : overflow.reasonCode, 'EXPOSURE_OVERFLOW');

    const admitted = admittedProfile();
    assert.ok(admitted.ok);
    const forged = deriveExposureCeiling({ ...admitted.value });
    assert.equal(forged.ok ? '' : forged.reasonCode, 'NOT_ADMITTED');
  });
});

describe('typed source intake', () => {
  it('binds configured catalog cases with real digest identities and no host paths', () => {
    const profile = admittedProfile();
    assert.ok(profile.ok);
    const result = bindEvaluationSource({ kind: 'catalog', caseIds: ['case-001'] }, hostFor(profile.value));
    assert.ok(result.ok);
    assert.equal(result.value.kind, 'catalog');
    const binding = result.value.bindings[0];
    assert.ok(binding);
    assert.equal(binding.caseDigest, entry('case-001').caseDigest);
    assert.equal(binding.initialRepositoryDigest, entry('case-001').initialRepositoryDigest);
    assert.equal(binding.catalogEntryId, 'entry-case-001');
    assert.equal(binding.grader.digest, entry('case-001').grader.digest);
    assert.equal('fixturePath' in binding, false);
    assert.equal('path' in binding.grader, false);
  });

  it('denies unknown catalog cases and unknown source fields', () => {
    const profile = admittedProfile();
    assert.ok(profile.ok);
    const unknownCase = bindEvaluationSource({ kind: 'catalog', caseIds: ['case-404'] }, hostFor(profile.value));
    assert.equal(unknownCase.ok ? '' : unknownCase.reasonCode, 'UNKNOWN_CASE');
    const extra = bindEvaluationSource({ kind: 'catalog', caseIds: ['case-001'], shell: 'bash' }, hostFor(profile.value));
    assert.equal(extra.ok ? '' : extra.reasonCode, 'UNKNOWN_FIELD');
  });

  it('denies unconfigured repository and check-set ids before any effect', () => {
    const profile = admittedProfile();
    assert.ok(profile.ok);
    const unconfiguredRepo = bindEvaluationSource(bugSource({ repositoryId: 'repo-unknown' }), hostFor(profile.value));
    assert.equal(unconfiguredRepo.ok ? '' : unconfiguredRepo.reasonCode, 'UNCONFIGURED_REPOSITORY');
    const unconfiguredChecks = bindEvaluationSource(bugSource({ checkSetId: 'checks-unknown' }), hostFor(profile.value));
    assert.equal(unconfiguredChecks.ok ? '' : unconfiguredChecks.reasonCode, 'UNCONFIGURED_CHECK_SET');
  });

  it('returns a persisted needs-info submission with bound questions and no task', () => {
    const profile = admittedProfile();
    assert.ok(profile.ok);
    const result = bindEvaluationSource(bugSource({}, { reproduction: '', acceptanceCriteria: [] }), hostFor(profile.value));
    assert.ok(result.ok);
    assert.equal(result.value.kind, 'bug');
    if (result.value.kind !== 'bug') return;
    assert.equal(result.value.status, 'needs-info');
    assert.equal(result.value.taskId, null);
    assert.equal(typeof result.value.submissionId, 'string');
    assert.match(result.value.submissionDigest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(
      result.value.questions.map(question => question.questionId),
      ['q-reproduction', 'q-acceptance-criteria'],
    );
    assert.equal(
      result.value.questions.every(question => question.text.length > 0),
      true,
    );
  });

  it('returns a complete exploratory submission for a full report', () => {
    const profile = admittedProfile();
    assert.ok(profile.ok);
    const result = bindEvaluationSource(bugSource({}, { constraints: ['No new dependencies'] }), hostFor(profile.value));
    assert.ok(result.ok);
    if (result.value.kind !== 'bug') return assert.fail('expected bug source');
    assert.equal(result.value.status, 'complete');
    assert.deepEqual(result.value.questions, []);
    assert.equal(result.value.taskId, null);
    assert.deepEqual(result.value.bugInput.constraints, ['No new dependencies']);
  });

  it('rejects unknown bug fields and oversized text', () => {
    const profile = admittedProfile();
    assert.ok(profile.ok);
    const unknown = bindEvaluationSource(bugSource({}, { admin: true }), hostFor(profile.value));
    assert.equal(unknown.ok ? '' : unknown.reasonCode, 'UNKNOWN_FIELD');
    const oversized = bindEvaluationSource(bugSource({}, { goal: 'x'.repeat(4097) }), hostFor(profile.value));
    assert.equal(oversized.ok ? '' : oversized.reasonCode, 'INVALID_TEXT');
    const tooMany = bindEvaluationSource(bugSource({}, { acceptanceCriteria: Array.from({ length: 17 }, (_, index) => `criterion ${index}`) }), hostFor(profile.value));
    assert.equal(tooMany.ok ? '' : tooMany.reasonCode, 'INVALID_LIST');
    const unknownKind = bindEvaluationSource({ kind: 'shell', command: 'ls' }, hostFor(profile.value));
    assert.equal(unknownKind.ok ? '' : unknownKind.reasonCode, 'INVALID_SOURCE');
  });
});

test('source binding requires an admitted profile', () => {
  const profile = admittedProfile();
  assert.ok(profile.ok);
  const host = { ...hostFor(profile.value), profile: { ...profile.value } };
  const result = bindEvaluationSource({ kind: 'catalog', caseIds: ['case-001'] }, host);
  assert.equal(result.ok ? '' : result.reasonCode, 'NOT_ADMITTED');
});
