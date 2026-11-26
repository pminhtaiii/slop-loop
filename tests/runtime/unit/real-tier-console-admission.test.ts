/**
 * Controlled acceptance tests for real-tier console admission (Feature 007 T017, ticket #270).
 *
 * Covers `--print-host-template` -> `loadHostConfiguration` -> `prepareUC03Host` ->
 * `admitRealTierConsole` -> `createEvaluationConsoleHost` with stub routes, catalog fixture/grader
 * digest verification, insecure-http acknowledgement, host/profile mismatch refusals with zero effects
 * and zero echoed rejected values, and preservation of controlled `admitEvaluationProfile`.
 * Uses RFC 5737 / `.invalid` addresses only; zero live model calls and zero Docker runs.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadHostConfiguration } from '../../../src/cli/evaluate-host.ts';
import { runEvaluationConsoleCli } from '../../../src/cli/evaluate-console.ts';
import { runRealTierScanCli } from '../../../src/cli/real-tier-scan.ts';
import type { OwnerDelivery } from '../../../src/runtime/evaluation-composition.ts';
import { createEvaluationConsoleHost, type EvaluationConsoleAssembly, type EvaluationConsoleConfiguration } from '../../../src/runtime/evaluation-console-host.ts';
import { admitEvaluationProfile, bindEvaluationSource, deriveExposureCeiling, isAdmittedEvaluationProfile } from '../../../src/runtime/evaluation-profile.ts';
import { admitRealTierConsole, isAdmittedRealTierConsole, realTierHostDigestsOf } from '../../../src/runtime/real-tier-console-admission.ts';
import type { ScanGit } from '../../../src/runtime/real-tier-endpoint-scan.ts';
import { DEFAULT_REAL_TIER_ENDPOINT, loadRealTierProfile, type RealTierEnvironment, type RealTierProfile } from '../../../src/runtime/real-tier-profile.ts';
import { prepareUC03Host, type UC03HostInputs } from '../../../src/runtime/uc03-host-bootstrap.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { REQUIRED_PORTS_V02_METHODS, UC03_PRODUCTION_COMPONENTS_V02, portDeclarationsV02 } from '../../../src/uc03/graph-types-v02.ts';
import { createScanFixture } from './real-tier-scan-fixtures.ts';

const REV = 'a'.repeat(40);
const CONTRACT_VERSION = 'uc03-owner-delivery/1';
const OPERATOR_TOKEN = 'real-tier-local-operator-token';
const gitHeadStub: ScanGit = async args => (args[0] === 'rev-parse' && args[1] === 'HEAD' ? { ok: true, stdout: `${REV}\n`, stderr: '' } : { ok: false, stdout: '', stderr: 'unsupported' });

interface CatalogFilesSetup {
  readonly dir: string;
  readonly catalogPath: string;
  readonly caseFixturePath: string;
  readonly caseGraderPath: string;
  readonly secondFixturePath: string;
  readonly secondGraderPath: string;
  readonly initialDigest: string;
}

function writeRealTierCatalog(prefix: string, options: { includeCriteria?: boolean; twoEntries?: boolean } = {}): CatalogFilesSetup {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const initialDigest = sha256Text('initial-repo');
  const caseFixtureRaw = JSON.stringify({ taskId: 'task-c01', initialRevisionDigest: initialDigest });
  const caseGraderRaw = JSON.stringify({ criteria: { criteria: [{ caseId: 'C01' }] }, profile: { kind: 'real-tier' }, graderPayload: null });
  const caseFixturePath = join(dir, 'fixture-c01.json');
  const caseGraderPath = join(dir, 'grader-c01.json');
  writeFileSync(caseFixturePath, caseFixtureRaw, 'utf8');
  writeFileSync(caseGraderPath, caseGraderRaw, 'utf8');

  const secondFixtureRaw = JSON.stringify({ taskId: 'task-c02', initialRevisionDigest: initialDigest });
  const secondGraderRaw = JSON.stringify({ criteria: { criteria: [{ caseId: 'C02' }] }, profile: { kind: 'real-tier' }, graderPayload: null });
  const secondFixturePath = join(dir, 'fixture-c02.json');
  const secondGraderPath = join(dir, 'grader-c02.json');
  writeFileSync(secondFixturePath, secondFixtureRaw, 'utf8');
  writeFileSync(secondGraderPath, secondGraderRaw, 'utf8');

  const entryOne = {
    caseId: 'C01',
    fixturePath: caseFixturePath,
    fixtureDigest: sha256Text(caseFixtureRaw),
    initialRepositoryDigest: initialDigest,
    ...(options.includeCriteria ? { criteria: { id: 'C01', predicate: 'repair-success' } } : {}),
    grader: { path: caseGraderPath, digest: `sha256:${sha256Text(caseGraderRaw)}` },
  };
  const entryTwo = {
    caseId: 'C02',
    fixturePath: secondFixturePath,
    fixtureDigest: sha256Text(secondFixtureRaw),
    initialRepositoryDigest: initialDigest,
    ...(options.includeCriteria ? { criteria: ['clarification'] } : {}),
    grader: { path: secondGraderPath, digest: `sha256:${sha256Text(secondGraderRaw)}` },
  };

  const entries = options.twoEntries ? [entryTwo, entryOne] : [entryOne];
  const catalogPath = join(dir, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify({ catalog: entries }), 'utf8');
  return { dir, catalogPath, caseFixturePath, caseGraderPath, secondFixturePath, secondGraderPath, initialDigest };
}

interface EffectCounters {
  ownerCalls: number;
  routeCalls: number;
  tokenCalls: number;
  taskResolveCalls: number;
  providerOrContainerCalls: number;
}

function countingReadyHost(identity: Readonly<Record<string, string>>, counters: EffectCounters) {
  const hostComponents = new Set(['guardedRead', 'baselineEvidence', 'hostAuthority', 'contextSource']);
  const owner = UC03_PRODUCTION_COMPONENTS_V02.filter(component => !hostComponents.has(component)).map(component => ({
    component,
    id: `real-${component}`,
    contractVersion: CONTRACT_VERSION,
    revision: REV,
    provenance: 'real' as const,
    adapter: {
      provenance: 'real',
      ...portDeclarationsV02(component),
      ...Object.fromEntries(
        REQUIRED_PORTS_V02_METHODS[component].map(method => [
          method,
          () => {
            counters.ownerCalls += 1;
            if (component === 'modelPort' || component === 'reviewerModelPort' || component === 'executionGuard') {
              counters.providerOrContainerCalls += 1;
            }
            return undefined;
          },
        ]),
      ),
    },
  })) as OwnerDelivery[];

  const producers = {
    guardedRead: {
      provenance: 'real',
      mediateRead: () => {
        counters.ownerCalls += 1;
        return undefined;
      },
    },
    baselineEvidence: {
      provenance: 'real',
      persistBaselineEvidence: () => {
        counters.ownerCalls += 1;
        return undefined;
      },
      loadBaselineEvidence: () => {
        counters.ownerCalls += 1;
        return undefined;
      },
    },
    hostAuthority: {
      loadSnapshot: () => {
        counters.ownerCalls += 1;
        return undefined;
      },
    },
    contextSource: {
      provenance: 'real',
      observe: () => {
        counters.ownerCalls += 1;
        return undefined;
      },
    },
  } as unknown as UC03HostInputs['producers'];

  const hostInputs: UC03HostInputs = {
    pins: {
      contractVersion: CONTRACT_VERSION,
      revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, REV])),
    },
    owner,
    producers,
    config: { trustedExpectedContext: { admissionContextForCheck: () => undefined } } as unknown as UC03HostInputs['config'],
    identity,
  };
  const readiness = prepareUC03Host(hostInputs);
  assert.equal(readiness.status, 'ready');
  return { hostInputs, readiness };
}

function stubAssemblyFromAdmission(admitted: ReturnType<typeof admitRealTierConsole>, counters: EffectCounters, initialDigest: string): EvaluationConsoleAssembly {
  if (!admitted.ok) {
    throw new Error(`Admission refused: ${admitted.reasonCode}`);
  }
  const { profile, catalog } = admitted.value;
  return {
    profile,
    catalog,
    repositoryIds: ['repo-real'],
    checkSetIds: ['checks-real'],
    control: {
      issue: input => ({ receiptRef: 'stub-control', kind: input.kind, taskId: 'task-c01', controlVersion: input.expectedControlVersion + 1 }),
    },
    approval: {
      presentation: () => ({ ok: true, value: { status: 'pending' } }),
      decide: () => ({ ok: true, value: { status: 'accepted' } }),
    },
    routesFor(ready, receivedCatalog) {
      counters.routeCalls += 1;
      return new Map(
        receivedCatalog.map(entry => [
          entry.caseId,
          {
            entry,
            readiness: ready,
            coderBudget: { maxModelCalls: 4, maxActiveMs: 60000, maxRepairs: 2, maxReplans: 3 },
            expectedWait: null,
            resolveTask() {
              counters.taskResolveCalls += 1;
              return {
                taskId: `task-${entry.caseId}`,
                repositoryId: 'repo-real',
                initialRevisionDigest: initialDigest,
              } as never;
            },
            resolveDirection: () => undefined,
          },
        ]),
      );
    },
    operatorToken() {
      counters.tokenCalls += 1;
      return OPERATOR_TOKEN;
    },
  };
}

function loadProfileOrThrow(env: RealTierEnvironment, repositoryRoot: string): RealTierProfile {
  const loaded = loadRealTierProfile(env, { repositoryRoot });
  assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.reasonCode);
  if (!loaded.ok) throw new Error('Expected valid RealTierProfile');
  return loaded.value;
}

test('AC1 & AC2: console admits host template with sha256 digests, real-tier catalog with criteria, and serves /api/catalog', async () => {
  const fixture = createScanFixture('t017-ac1-', 't017-key-ac1');
  const catalogFiles = writeRealTierCatalog('t017-cat-ac1-', { includeCriteria: true, twoEntries: true });
  const workDir = mkdtempSync(join(tmpdir(), 't017-work-ac1-'));
  try {
    const env = fixture.envOf({ catalog: { path: catalogFiles.catalogPath } });
    const realProfile = loadProfileOrThrow(env, fixture.REPO);

    const scanResult = await runRealTierScanCli(['--print-host-template'], { env, repositoryRoot: fixture.REPO, git: gitHeadStub });
    assert.equal(scanResult.exitCode, 0, scanResult.output);
    const sharedDigests = realTierHostDigestsOf(realProfile);
    const parsedTemplate = JSON.parse(scanResult.output) as Record<string, unknown>;
    assert.equal(parsedTemplate.profileDigest, sharedDigests.profileDigest);
    assert.equal(parsedTemplate.configDigest, sharedDigests.configDigest);
    assert.equal(parsedTemplate.pricingDigest, sharedDigests.pricingDigest);
    assert.equal(parsedTemplate.requestedModel, sharedDigests.requestedModel);
    assert.deepEqual(parsedTemplate.adapterVersions, sharedDigests.adapterVersions);

    const hostFile = join(workDir, 'host.json');
    writeFileSync(hostFile, scanResult.output, 'utf8');
    const hostLoaded = loadHostConfiguration(hostFile);
    assert.equal(hostLoaded.ok, true);
    if (!hostLoaded.ok) return;

    const counters: EffectCounters = { ownerCalls: 0, routeCalls: 0, tokenCalls: 0, taskResolveCalls: 0, providerOrContainerCalls: 0 };
    const { readiness } = countingReadyHost(hostLoaded.value.identity, counters);
    const admitted = admitRealTierConsole({ profile: realProfile, configuration: hostLoaded.value });
    assert.equal(admitted.ok, true, admitted.ok ? '' : admitted.reasonCode);
    if (!admitted.ok) return;

    // Host-only WeakSet receipts reject spread/forged copies and bind exact configuration.
    assert.equal(isAdmittedRealTierConsole(admitted.value), true);
    assert.equal(isAdmittedRealTierConsole(admitted.value, hostLoaded.value), true);
    assert.equal(isAdmittedRealTierConsole({ ...admitted.value }), false);
    assert.equal(isAdmittedEvaluationProfile(admitted.value.profile), true);
    assert.equal(isAdmittedEvaluationProfile({ ...admitted.value.profile }), false);
    assert.equal(admitted.value.catalog.map(entry => entry.caseId).join(','), 'C01,C02');

    const ceiling = deriveExposureCeiling(admitted.value.profile);
    assert.equal(ceiling.ok, true);

    const bound = bindEvaluationSource(
      { kind: 'catalog', caseIds: ['C01'] },
      { profile: admitted.value.profile, catalog: admitted.value.catalog, repositoryIds: ['repo-real'], checkSetIds: ['checks-real'] },
    );
    assert.equal(bound.ok, true);

    const host = await createEvaluationConsoleHost(readiness, hostLoaded.value, () => stubAssemblyFromAdmission(admitted, counters, catalogFiles.initialDigest));
    assert.equal(host.ok, true);
    if (!host.ok) return;
    try {
      const origin = `http://${host.host.address.host}:${host.host.address.port}`;
      const response = await fetch(`${origin}/api/catalog`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        readonly ok: boolean;
        readonly result: { readonly cases: readonly { readonly caseId: string; readonly ready: boolean; readonly graderDigest: string }[] };
      };
      assert.equal(body.ok, true);
      assert.deepEqual(
        body.result.cases.map(item => ({ caseId: item.caseId, ready: item.ready })),
        [
          { caseId: 'C01', ready: true },
          { caseId: 'C02', ready: true },
        ],
      );
      assert.equal(counters.ownerCalls, 0);
      assert.equal(counters.providerOrContainerCalls, 0);
    } finally {
      await host.host.close();
    }

    // Also prove `evaluate serve` accepts the real-tier host file through the CLI boundary.
    const cliCounters: EffectCounters = { ownerCalls: 0, routeCalls: 0, tokenCalls: 0, taskResolveCalls: 0, providerOrContainerCalls: 0 };
    const cliHost = countingReadyHost(hostLoaded.value.identity, cliCounters);
    const cliResult = await runEvaluationConsoleCli(
      ['serve', '--host', hostFile],
      {
        loadConfiguration: path => loadHostConfiguration(path),
        resolveAssembly: async () => ({
          host: cliHost.hostInputs,
          console: ({ configuration: cfg }) => stubAssemblyFromAdmission(admitRealTierConsole({ profile: realProfile, configuration: cfg }), cliCounters, catalogFiles.initialDigest),
        }),
        prepareAssembly: () => prepareUC03Host(cliHost.hostInputs),
        readinessReport: () => 'unavailable',
      },
      false,
    );
    try {
      assert.equal(cliResult.exitCode, 0, cliResult.output);
      assert.equal(JSON.parse(cliResult.output).outcome, 'listening');
    } finally {
      await cliResult.close?.();
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(catalogFiles.dir, { recursive: true, force: true });
    rmSync(fixture.OUTSIDE, { recursive: true, force: true });
    rmSync(fixture.REPO, { recursive: true, force: true });
    rmSync(fixture.BASE, { recursive: true, force: true });
  }
});

test('AC2: real-tier catalog admits optional-criteria format and refuses fixture/grader digest mismatches or bad catalog entries', async () => {
  const fixture = createScanFixture('t017-ac2-', 't017-key-ac2');
  const catalogFiles = writeRealTierCatalog('t017-cat-ac2-', { includeCriteria: false });
  try {
    const env = fixture.envOf({ catalog: { path: catalogFiles.catalogPath } });
    const realProfile = loadProfileOrThrow(env, fixture.REPO);
    const configuration: EvaluationConsoleConfiguration = {
      ...realTierHostDigestsOf(realProfile),
      identity: (() => {
        const d = realTierHostDigestsOf(realProfile);
        return { profileId: d.profileId, profileDigest: d.profileDigest, configDigest: d.configDigest, pricingDigest: d.pricingDigest };
      })(),
    };

    const valid = admitRealTierConsole({ profile: realProfile, configuration });
    assert.equal(valid.ok, true, valid.ok ? '' : valid.reasonCode);

    // Tamper fixture content without updating fixtureDigest.
    const originalFixture = JSON.stringify({ taskId: 'task-c01', initialRevisionDigest: catalogFiles.initialDigest });
    writeFileSync(catalogFiles.caseFixturePath, JSON.stringify({ tampered: true }), 'utf8');
    const badFixture = admitRealTierConsole({ profile: realProfile, configuration });
    assert.equal(badFixture.ok, false);
    assert.equal(badFixture.ok ? '' : badFixture.reasonCode, 'FIXTURE_DIGEST_MISMATCH');
    writeFileSync(catalogFiles.caseFixturePath, originalFixture, 'utf8');

    // Tamper grader file content without updating grader.digest.
    const originalGrader = JSON.stringify({ criteria: { criteria: [{ caseId: 'C01' }] }, profile: { kind: 'real-tier' }, graderPayload: null });
    writeFileSync(catalogFiles.caseGraderPath, JSON.stringify({ tampered: true }), 'utf8');
    const badGrader = admitRealTierConsole({ profile: realProfile, configuration });
    assert.equal(badGrader.ok, false);
    assert.equal(badGrader.ok ? '' : badGrader.reasonCode, 'GRADER_DIGEST_MISMATCH');
    writeFileSync(catalogFiles.caseGraderPath, originalGrader, 'utf8');

    // Remove grader file completely.
    rmSync(catalogFiles.caseGraderPath);
    const missingGrader = admitRealTierConsole({ profile: realProfile, configuration });
    assert.equal(missingGrader.ok, false);
    assert.equal(missingGrader.ok ? '' : missingGrader.reasonCode, 'MISSING_GRADER');

    // Duplicate caseId, empty catalog, and secret-bearing catalog are refused cleanly without echoing content.
    writeFileSync(
      catalogFiles.catalogPath,
      JSON.stringify({
        catalog: [
          {
            caseId: 'C01',
            fixturePath: catalogFiles.caseFixturePath,
            fixtureDigest: sha256Text(originalFixture),
            initialRepositoryDigest: catalogFiles.initialDigest,
            grader: { path: catalogFiles.secondGraderPath, digest: sha256Text(JSON.stringify({ criteria: { criteria: [{ caseId: 'C02' }] }, profile: { kind: 'real-tier' }, graderPayload: null })) },
          },
          {
            caseId: 'C01',
            fixturePath: catalogFiles.caseFixturePath,
            fixtureDigest: sha256Text(originalFixture),
            initialRepositoryDigest: catalogFiles.initialDigest,
            grader: { path: catalogFiles.secondGraderPath, digest: sha256Text(JSON.stringify({ criteria: { criteria: [{ caseId: 'C02' }] }, profile: { kind: 'real-tier' }, graderPayload: null })) },
          },
        ],
      }),
      'utf8',
    );
    const duplicate = admitRealTierConsole({ profile: realProfile, configuration });
    assert.equal(duplicate.ok ? '' : duplicate.reasonCode, 'DUPLICATE_CATALOG_ENTRY');

    writeFileSync(catalogFiles.catalogPath, JSON.stringify({ catalog: [], extra: 'sk-ant-abcdefghijklmnopqrstuvwx' }), 'utf8');
    const secret = admitRealTierConsole({ profile: realProfile, configuration });
    assert.equal(secret.ok ? '' : secret.reasonCode, 'SECRET_MATERIAL');
    assert.equal(JSON.stringify(secret).includes('sk-ant-'), false);

    // Console host refuses catalog-failed admission with zero route/token/owner effects.
    const counters: EffectCounters = { ownerCalls: 0, routeCalls: 0, tokenCalls: 0, taskResolveCalls: 0, providerOrContainerCalls: 0 };
    const { readiness } = countingReadyHost(configuration.identity, counters);
    const hostResult = await createEvaluationConsoleHost(readiness, configuration, () => stubAssemblyFromAdmission(secret, counters, catalogFiles.initialDigest));
    assert.deepEqual(hostResult, { ok: false, reasonCode: 'HOST_CONSOLE_UNAVAILABLE' });
    assert.equal(counters.routeCalls, 0);
    assert.equal(counters.tokenCalls, 0);
    assert.equal(counters.ownerCalls, 0);
  } finally {
    rmSync(catalogFiles.dir, { recursive: true, force: true });
    rmSync(fixture.OUTSIDE, { recursive: true, force: true });
    rmSync(fixture.REPO, { recursive: true, force: true });
    rmSync(fixture.BASE, { recursive: true, force: true });
  }
});

test('AC3: insecure http endpoint is admitted only with acknowledgement; https and default endpoint work, unacknowledged http is refused', async () => {
  const fixture = createScanFixture('t017-ac3-', 't017-key-ac3');
  const catalogFiles = writeRealTierCatalog('t017-cat-ac3-');
  try {
    // 1. Insecure http with allowInsecureHttp: true -> admitted.
    const httpEnv = fixture.envOf({ catalog: { path: catalogFiles.catalogPath } });
    const httpProfile = loadProfileOrThrow(httpEnv, fixture.REPO);
    const httpDigests = realTierHostDigestsOf(httpProfile);
    const httpConfig: EvaluationConsoleConfiguration = {
      ...httpDigests,
      identity: { profileId: httpDigests.profileId, profileDigest: httpDigests.profileDigest, configDigest: httpDigests.configDigest, pricingDigest: httpDigests.pricingDigest },
    };
    const httpAdmitted = admitRealTierConsole({ profile: httpProfile, configuration: httpConfig });
    assert.equal(httpAdmitted.ok, true);
    if (httpAdmitted.ok) {
      assert.deepEqual(httpAdmitted.value.profile.endpoint, { origin: 'http://192.0.2.10:54321', path: '/v1/messages' });
    }

    // 2. Unacknowledged http is refused at profile load AND if a profile disables acknowledgement.
    const unackEnv = fixture.envOf({
      catalog: { path: catalogFiles.catalogPath },
      provider: { ...fixture.PROVIDER, allowInsecureHttp: false },
    });
    const unackLoaded = loadRealTierProfile(unackEnv, { repositoryRoot: fixture.REPO });
    assert.equal(unackLoaded.ok, false);
    assert.equal(unackLoaded.ok ? '' : unackLoaded.reasonCode, 'insecure-endpoint-unacknowledged');

    // Crafted RealTierProfile claiming http without acknowledgement or with spoofed transport is refused by admitRealTierConsole.
    for (const bad of [
      { transport: 'https' as const, insecureHttpAcknowledged: false },
      { transport: 'https' as const, insecureHttpAcknowledged: true },
      { transport: 'insecure-http-acknowledged' as const, insecureHttpAcknowledged: false },
    ]) {
      const craftedUnack = Object.defineProperty(
        {
          ...httpProfile,
          transport: bad.transport,
          endpoint: Object.defineProperty({ ...httpProfile.endpoint, insecureHttpAcknowledged: bad.insecureHttpAcknowledged }, 'href', { value: httpProfile.endpoint.href, enumerable: false }),
        },
        'endpointDigestKey',
        { value: httpProfile.endpointDigestKey, enumerable: false },
      ) as RealTierProfile;
      const unackAdmitted = admitRealTierConsole({ profile: craftedUnack, configuration: httpConfig });
      assert.equal(unackAdmitted.ok, false);
      assert.equal(unackAdmitted.ok ? '' : unackAdmitted.reasonCode, 'INSECURE_ENDPOINT_UNACKNOWLEDGED');
      assert.equal(JSON.stringify(unackAdmitted).includes('192.0.2.10'), false);
    }

    // 3. Default HTTPS public endpoint (without endpointDigestKey) -> admitted.
    const defaultEnv = fixture.envOf({
      catalog: { path: catalogFiles.catalogPath },
      provider: { model: fixture.MODEL, mode: 'nonstreaming', timeoutMs: 60000 },
    });
    const defaultProfile = loadProfileOrThrow(defaultEnv, fixture.REPO);
    const defaultDigests = realTierHostDigestsOf(defaultProfile);
    const defaultConfig: EvaluationConsoleConfiguration = {
      ...defaultDigests,
      identity: { profileId: defaultDigests.profileId, profileDigest: defaultDigests.profileDigest, configDigest: defaultDigests.configDigest, pricingDigest: defaultDigests.pricingDigest },
    };
    const defaultAdmitted = admitRealTierConsole({ profile: defaultProfile, configuration: defaultConfig });
    assert.equal(defaultAdmitted.ok, true);
    if (defaultAdmitted.ok) {
      const parsedDefault = new URL(DEFAULT_REAL_TIER_ENDPOINT);
      assert.deepEqual(defaultAdmitted.value.profile.endpoint, { origin: parsedDefault.origin, path: parsedDefault.pathname });
    }
  } finally {
    rmSync(catalogFiles.dir, { recursive: true, force: true });
    rmSync(fixture.OUTSIDE, { recursive: true, force: true });
    rmSync(fixture.REPO, { recursive: true, force: true });
    rmSync(fixture.BASE, { recursive: true, force: true });
  }
});

test('AC4: any digest, model or adapter mismatch between host file and profile is refused with zero effects and no echoed values', async () => {
  const fixture = createScanFixture('t017-ac4-', 't017-key-ac4');
  const catalogFiles = writeRealTierCatalog('t017-cat-ac4-');
  try {
    const env = fixture.envOf({ catalog: { path: catalogFiles.catalogPath } });
    const realProfile = loadProfileOrThrow(env, fixture.REPO);
    const validDigests = realTierHostDigestsOf(realProfile);
    const validIdentity = {
      profileId: validDigests.profileId,
      profileDigest: validDigests.profileDigest,
      configDigest: validDigests.configDigest,
      pricingDigest: validDigests.pricingDigest,
    };
    const validConfig: EvaluationConsoleConfiguration = { ...validDigests, identity: validIdentity };
    const baselineReceipt = admitRealTierConsole({ profile: realProfile, configuration: validConfig });
    assert.equal(baselineReceipt.ok, true);
    if (!baselineReceipt.ok) return;

    const badProfileDigest = `sha256:${sha256Text('rejected-profile-sentinel')}`;
    const badConfigDigest = `sha256:${sha256Text('rejected-config-sentinel')}`;
    const badPricingDigest = `sha256:${sha256Text('rejected-pricing-sentinel')}`;
    const badModel = 'rejected-model.invalid/v9';
    const badAdapter = 'rejected-adapter/99';

    const mismatches: readonly { readonly config: EvaluationConsoleConfiguration; readonly code: string; readonly sentinel: string }[] = [
      { config: { ...validConfig, profileDigest: badProfileDigest }, code: 'PROFILE_DIGEST_MISMATCH', sentinel: badProfileDigest },
      { config: { ...validConfig, identity: { ...validIdentity, profileDigest: badProfileDigest } }, code: 'PROFILE_DIGEST_MISMATCH', sentinel: badProfileDigest },
      { config: { ...validConfig, configDigest: badConfigDigest }, code: 'CONFIG_DIGEST_MISMATCH', sentinel: badConfigDigest },
      { config: { ...validConfig, pricingDigest: badPricingDigest }, code: 'PRICING_DIGEST_MISMATCH', sentinel: badPricingDigest },
      { config: { ...validConfig, identity: { ...validIdentity, profileId: 'wrong-profile-id' } }, code: 'PROFILE_ID_MISMATCH', sentinel: 'wrong-profile-id' },
      { config: { ...validConfig, requestedModel: badModel }, code: 'MODEL_MISMATCH', sentinel: badModel },
      { config: { ...validConfig, adapterVersions: [badAdapter] }, code: 'ADAPTER_MISMATCH', sentinel: badAdapter },
    ];

    for (const item of mismatches) {
      assert.equal(isAdmittedRealTierConsole(baselineReceipt.value, item.config), false);

      const refused = admitRealTierConsole({ profile: realProfile, configuration: item.config });
      assert.equal(refused.ok, false);
      assert.equal(refused.ok ? '' : refused.reasonCode, item.code);
      assert.equal(JSON.stringify(refused).includes(item.sentinel), false, 'rejected value must never be echoed');

      const counters: EffectCounters = { ownerCalls: 0, routeCalls: 0, tokenCalls: 0, taskResolveCalls: 0, providerOrContainerCalls: 0 };
      const { readiness } = countingReadyHost(item.config.identity, counters);
      const hostResult = await createEvaluationConsoleHost(readiness, item.config, ({ configuration }) =>
        stubAssemblyFromAdmission(admitRealTierConsole({ profile: realProfile, configuration }), counters, catalogFiles.initialDigest),
      );
      assert.deepEqual(hostResult, { ok: false, reasonCode: 'HOST_CONSOLE_UNAVAILABLE' });
      assert.equal(JSON.stringify(hostResult).includes(item.sentinel), false);
      assert.equal(counters.ownerCalls, 0);
      assert.equal(counters.routeCalls, 0);
      assert.equal(counters.tokenCalls, 0);
      assert.equal(counters.taskResolveCalls, 0);
      assert.equal(counters.providerOrContainerCalls, 0);

      // Even if a mismatched configuration tried to reuse the previously admitted real-tier EvaluationProfile, console host refuses it.
      const reuseHost = await createEvaluationConsoleHost(readiness, item.config, () => stubAssemblyFromAdmission(baselineReceipt, counters, catalogFiles.initialDigest));
      assert.deepEqual(reuseHost, { ok: false, reasonCode: 'HOST_CONSOLE_UNAVAILABLE' });
      assert.equal(counters.routeCalls, 0);
      assert.equal(counters.tokenCalls, 0);
    }
  } finally {
    rmSync(catalogFiles.dir, { recursive: true, force: true });
    rmSync(fixture.OUTSIDE, { recursive: true, force: true });
    rmSync(fixture.REPO, { recursive: true, force: true });
    rmSync(fixture.BASE, { recursive: true, force: true });
  }
});

test('AC5: controlled evaluation-profile admission remains unchanged and still rejects http or sha256-prefixed digests', () => {
  const dir = mkdtempSync(join(tmpdir(), 't017-ac5-'));
  try {
    const fixturePath = join(dir, 'case.json');
    const graderPath = join(dir, 'grader.json');
    writeFileSync(fixturePath, '{}', 'utf8');
    writeFileSync(graderPath, '{}', 'utf8');
    const baseInput = {
      endpoint: 'https://model.invalid/v1/messages',
      model: 'deepseek-v4.1',
      mode: 'nonstreaming',
      credentialRef: 'host-deepseek-key',
      codeDigest: sha256Text('code'),
      configDigest: sha256Text('config'),
      imageDigest: `sha256:${sha256Text('image')}`,
      platform: 'linux/amd64',
      adapterVersions: ['uc03-adapter@1'],
      pricing: { pricingId: 'p1', inputRate: 10, outputRate: 20, cacheRate: 5, overheadRate: 0, denominator: 1 },
      limits: {
        totalModelCalls: 8,
        inputTokensPerRequest: 4096,
        outputTokensPerRequest: 1024,
        providerTimeoutMs: 30000,
        activeExecutionMs: 60000,
        repairs: 2,
        reviewerIterations: 2,
        materialReplans: 3,
        commandTimeoutMs: 10000,
        outputBytes: 65536,
        memoryBytes: 536870912,
        cpus: 1,
        processes: 32,
      },
      catalog: [
        {
          catalogEntryId: 'entry-C01',
          caseId: 'C01',
          version: '1.0.0',
          caseDigest: sha256Text('case'),
          publicTaskDigest: sha256Text('task'),
          initialRepositoryDigest: sha256Text('repo'),
          fixturePath,
          fixtureDigest: sha256Text('fixture'),
          grader: { version: '1.0.0', digest: sha256Text('grader'), path: graderPath },
        },
      ],
    };

    const ok = admitEvaluationProfile(baseInput);
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(isAdmittedEvaluationProfile(ok.value), true);
      assert.equal(isAdmittedRealTierConsole(ok.value), false);
    }

    const rejectedHttp = admitEvaluationProfile({ ...baseInput, endpoint: 'http://192.0.2.10:8080/v1/messages' });
    assert.equal(rejectedHttp.ok ? '' : rejectedHttp.reasonCode, 'INVALID_ENDPOINT');

    const rejectedPrefix = admitEvaluationProfile({ ...baseInput, configDigest: `sha256:${sha256Text('config')}` });
    assert.equal(rejectedPrefix.ok ? '' : rejectedPrefix.reasonCode, 'INVALID_DIGEST');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readUtf8 translates non-file paths to *_UNREADABLE while keeping MISSING_* for absent entries', () => {
  const fixture = createScanFixture('t017-f1-dir-', 't017-key-f1-dir');
  const catalogFiles = writeRealTierCatalog('t017-cat-f1-dir-');
  const dirEntry = join(catalogFiles.dir, 'as-dir');
  mkdirSync(dirEntry);
  try {
    const configOf = (profile: RealTierProfile): EvaluationConsoleConfiguration => {
      const d = realTierHostDigestsOf(profile);
      return { ...d, identity: { profileId: d.profileId, profileDigest: d.profileDigest, configDigest: d.configDigest, pricingDigest: d.pricingDigest } };
    };

    const missingCatalogProfile = loadProfileOrThrow(fixture.envOf({ catalog: { path: join(catalogFiles.dir, 'missing.json') } }), fixture.REPO);
    const missingCatalog = admitRealTierConsole({ profile: missingCatalogProfile, configuration: configOf(missingCatalogProfile) });
    assert.equal(missingCatalog.ok ? '' : missingCatalog.reasonCode, 'MISSING_CATALOG');

    const dirCatalogProfile = loadProfileOrThrow(fixture.envOf({ catalog: { path: dirEntry } }), fixture.REPO);
    const dirCatalog = admitRealTierConsole({ profile: dirCatalogProfile, configuration: configOf(dirCatalogProfile) });
    assert.equal(dirCatalog.ok ? '' : dirCatalog.reasonCode, 'CATALOG_UNREADABLE');

    const realProfile = loadProfileOrThrow(fixture.envOf({ catalog: { path: catalogFiles.catalogPath } }), fixture.REPO);
    const configuration = configOf(realProfile);

    writeFileSync(
      catalogFiles.catalogPath,
      JSON.stringify({
        catalog: [
          {
            caseId: 'C01',
            fixturePath: dirEntry,
            fixtureDigest: sha256Text('{}'),
            initialRepositoryDigest: catalogFiles.initialDigest,
            grader: { path: catalogFiles.caseGraderPath, digest: sha256Text('{}') },
          },
        ],
      }),
      'utf8',
    );
    const dirFixture = admitRealTierConsole({ profile: realProfile, configuration });
    assert.equal(dirFixture.ok ? '' : dirFixture.reasonCode, 'FIXTURE_UNREADABLE');

    writeFileSync(
      catalogFiles.catalogPath,
      JSON.stringify({
        catalog: [
          {
            caseId: 'C01',
            fixturePath: catalogFiles.caseFixturePath,
            fixtureDigest: sha256Text(JSON.stringify({ taskId: 'task-c01', initialRevisionDigest: catalogFiles.initialDigest })),
            initialRepositoryDigest: catalogFiles.initialDigest,
            grader: { path: dirEntry, digest: sha256Text('{}') },
          },
        ],
      }),
      'utf8',
    );
    const dirGrader = admitRealTierConsole({ profile: realProfile, configuration });
    assert.equal(dirGrader.ok ? '' : dirGrader.reasonCode, 'GRADER_UNREADABLE');
  } finally {
    rmSync(catalogFiles.dir, { recursive: true, force: true });
    rmSync(fixture.OUTSIDE, { recursive: true, force: true });
    rmSync(fixture.REPO, { recursive: true, force: true });
    rmSync(fixture.BASE, { recursive: true, force: true });
  }
});

test('readUtf8 translates statSync errors other than no-entry to *_UNREADABLE', t => {
  const fixture = createScanFixture('t017-f1-stat-', 't017-key-f1-stat');
  const catalogFiles = writeRealTierCatalog('t017-cat-f1-stat-');
  try {
    const inaccessiblePath = join(catalogFiles.caseFixturePath, 'child.json');
    let statError = false;
    try {
      statSync(inaccessiblePath, { throwIfNoEntry: false });
    } catch {
      statError = true;
    }
    if (!statError) {
      t.skip('this platform reports a path below a regular file as absent, so no statSync error can be exercised');
      return;
    }

    const configOf = (profile: RealTierProfile): EvaluationConsoleConfiguration => {
      const d = realTierHostDigestsOf(profile);
      return { ...d, identity: { profileId: d.profileId, profileDigest: d.profileDigest, configDigest: d.configDigest, pricingDigest: d.pricingDigest } };
    };

    const badCatalogProfile = loadProfileOrThrow(fixture.envOf({ catalog: { path: inaccessiblePath } }), fixture.REPO);
    const badCatalog = admitRealTierConsole({ profile: badCatalogProfile, configuration: configOf(badCatalogProfile) });
    assert.equal(badCatalog.ok ? '' : badCatalog.reasonCode, 'CATALOG_UNREADABLE');

    const realProfile = loadProfileOrThrow(fixture.envOf({ catalog: { path: catalogFiles.catalogPath } }), fixture.REPO);
    const configuration = configOf(realProfile);

    writeFileSync(
      catalogFiles.catalogPath,
      JSON.stringify({
        catalog: [
          {
            caseId: 'C01',
            fixturePath: inaccessiblePath,
            fixtureDigest: sha256Text('{}'),
            initialRepositoryDigest: catalogFiles.initialDigest,
            grader: { path: catalogFiles.caseGraderPath, digest: sha256Text('{}') },
          },
        ],
      }),
      'utf8',
    );
    const badFixture = admitRealTierConsole({ profile: realProfile, configuration });
    assert.equal(badFixture.ok ? '' : badFixture.reasonCode, 'FIXTURE_UNREADABLE');

    writeFileSync(
      catalogFiles.catalogPath,
      JSON.stringify({
        catalog: [
          {
            caseId: 'C01',
            fixturePath: catalogFiles.caseFixturePath,
            fixtureDigest: sha256Text(JSON.stringify({ taskId: 'task-c01', initialRevisionDigest: catalogFiles.initialDigest })),
            initialRepositoryDigest: catalogFiles.initialDigest,
            grader: { path: inaccessiblePath, digest: sha256Text('{}') },
          },
        ],
      }),
      'utf8',
    );
    const badGrader = admitRealTierConsole({ profile: realProfile, configuration });
    assert.equal(badGrader.ok ? '' : badGrader.reasonCode, 'GRADER_UNREADABLE');
  } finally {
    rmSync(catalogFiles.dir, { recursive: true, force: true });
    rmSync(fixture.OUTSIDE, { recursive: true, force: true });
    rmSync(fixture.REPO, { recursive: true, force: true });
    rmSync(fixture.BASE, { recursive: true, force: true });
  }
});

test('configurationMismatch rejects sparse adapterVersions array while admitting valid one-element array', () => {
  const fixture = createScanFixture('t017-f2-', 't017-key-f2');
  const catalogFiles = writeRealTierCatalog('t017-cat-f2-');
  try {
    const env = fixture.envOf({ catalog: { path: catalogFiles.catalogPath } });
    const realProfile = loadProfileOrThrow(env, fixture.REPO);
    const d = realTierHostDigestsOf(realProfile);
    const validConfig: EvaluationConsoleConfiguration = {
      ...d,
      identity: { profileId: d.profileId, profileDigest: d.profileDigest, configDigest: d.configDigest, pricingDigest: d.pricingDigest },
    };
    const baseline = admitRealTierConsole({ profile: realProfile, configuration: validConfig });
    assert.equal(baseline.ok, true);
    if (!baseline.ok) return;

    const sparseConfig: EvaluationConsoleConfiguration = {
      ...validConfig,
      adapterVersions: new Array<string>(1),
    };
    assert.equal(isAdmittedRealTierConsole(baseline.value, sparseConfig), false);
    const sparseRefused = admitRealTierConsole({ profile: realProfile, configuration: sparseConfig });
    assert.equal(sparseRefused.ok, false);
    assert.equal(sparseRefused.ok ? '' : sparseRefused.reasonCode, 'ADAPTER_MISMATCH');
  } finally {
    rmSync(catalogFiles.dir, { recursive: true, force: true });
    rmSync(fixture.OUTSIDE, { recursive: true, force: true });
    rmSync(fixture.REPO, { recursive: true, force: true });
    rmSync(fixture.BASE, { recursive: true, force: true });
  }
});

test('catalog secret scan reports nearest schema-owned path without appending untrusted keys, leaving controlled admission unchanged', () => {
  const fixture = createScanFixture('t017-f3-', 't017-key-f3');
  const catalogFiles = writeRealTierCatalog('t017-cat-f3-');
  try {
    const realProfile = loadProfileOrThrow(fixture.envOf({ catalog: { path: catalogFiles.catalogPath } }), fixture.REPO);
    const d = realTierHostDigestsOf(realProfile);
    const configuration: EvaluationConsoleConfiguration = {
      ...d,
      identity: { profileId: d.profileId, profileDigest: d.profileDigest, configDigest: d.configDigest, pricingDigest: d.pricingDigest },
    };
    const secretVal = 'sk-ant-abcdefghijklmnopqrstuvwx';
    const baseEntry = {
      caseId: 'C01',
      fixturePath: catalogFiles.caseFixturePath,
      fixtureDigest: sha256Text(JSON.stringify({ taskId: 'task-c01', initialRevisionDigest: catalogFiles.initialDigest })),
      initialRepositoryDigest: catalogFiles.initialDigest,
      grader: { path: catalogFiles.caseGraderPath, digest: sha256Text(JSON.stringify({ criteria: { criteria: [{ caseId: 'C01' }] }, profile: { kind: 'real-tier' }, graderPayload: null })) },
    };

    const cases: readonly { readonly payload: unknown; readonly expectedPath: string; readonly hiddenKey?: string }[] = [
      { payload: { catalog: [], untrustedRootKey: secretVal }, expectedPath: '$.catalog', hiddenKey: 'untrustedRootKey' },
      { payload: { catalog: [{ ...baseEntry, untrustedEntryKey: secretVal }] }, expectedPath: '$.catalog.catalog[0]', hiddenKey: 'untrustedEntryKey' },
      { payload: { catalog: [{ ...baseEntry, criteria: { nestedCriteriaKey: secretVal } }] }, expectedPath: '$.catalog.catalog[0].criteria', hiddenKey: 'nestedCriteriaKey' },
      { payload: { catalog: [{ ...baseEntry, grader: { ...baseEntry.grader, untrustedGraderKey: secretVal } }] }, expectedPath: '$.catalog.catalog[0].grader', hiddenKey: 'untrustedGraderKey' },
      { payload: { catalog: [{ ...baseEntry, fixturePath: secretVal }] }, expectedPath: '$.catalog.catalog[0].fixturePath' },
    ];

    for (const item of cases) {
      writeFileSync(catalogFiles.catalogPath, JSON.stringify(item.payload), 'utf8');
      const refused = admitRealTierConsole({ profile: realProfile, configuration });
      assert.equal(refused.ok, false);
      if (!refused.ok) {
        assert.equal(refused.reasonCode, 'SECRET_MATERIAL');
        assert.equal(refused.path, item.expectedPath);
        assert.equal(JSON.stringify(refused).includes(secretVal), false);
        if (item.hiddenKey) assert.equal(JSON.stringify(refused).includes(item.hiddenKey), false);
      }
    }

    // Controlled admitEvaluationProfile continues to use assertNoSecret with full key paths.
    const controlledRefused = admitEvaluationProfile({
      endpoint: 'https://model.invalid/v1/messages',
      model: 'deepseek-v4.1',
      mode: 'nonstreaming',
      credentialRef: 'host-deepseek-key',
      codeDigest: sha256Text('code'),
      configDigest: sha256Text('config'),
      imageDigest: `sha256:${sha256Text('image')}`,
      platform: 'linux/amd64',
      adapterVersions: ['uc03-adapter@1'],
      pricing: { pricingId: 'p1', inputRate: 10, outputRate: 20, cacheRate: 5, overheadRate: 0, denominator: 1 },
      limits: {
        totalModelCalls: 8,
        inputTokensPerRequest: 4096,
        outputTokensPerRequest: 1024,
        providerTimeoutMs: 30000,
        activeExecutionMs: 60000,
        repairs: 2,
        reviewerIterations: 2,
        materialReplans: 3,
        commandTimeoutMs: 10000,
        outputBytes: 65536,
        memoryBytes: 536870912,
        cpus: 1,
        processes: 32,
      },
      catalog: [
        {
          catalogEntryId: 'entry-C01',
          caseId: 'C01',
          version: '1.0.0',
          caseDigest: sha256Text('case'),
          publicTaskDigest: sha256Text('task'),
          initialRepositoryDigest: sha256Text('repo'),
          fixturePath: catalogFiles.caseFixturePath,
          fixtureDigest: sha256Text('fixture'),
          grader: { version: '1.0.0', digest: sha256Text('grader'), path: catalogFiles.caseGraderPath },
          extraSecretKey: secretVal,
        },
      ],
    });
    assert.equal(controlledRefused.ok, false);
    if (!controlledRefused.ok) {
      assert.equal(controlledRefused.reasonCode, 'SECRET_MATERIAL');
      assert.equal(controlledRefused.path, '$.catalog[0].extraSecretKey');
    }
  } finally {
    rmSync(catalogFiles.dir, { recursive: true, force: true });
    rmSync(fixture.OUTSIDE, { recursive: true, force: true });
    rmSync(fixture.REPO, { recursive: true, force: true });
    rmSync(fixture.BASE, { recursive: true, force: true });
  }
});
